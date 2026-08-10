import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

import {
  clearCursorIsolatedCliConfigs,
  createCursorIsolatedConfigDir,
  removeCursorIsolatedConfigDir,
  readUserNetworkConfigFromEnv,
  resolveCursorIsolatedConfigDir,
} from './isolatedConfig.js';

function mkUserData(): string {
  return mkdtempSync(join(tmpdir(), 'cindy-iso-'));
}

describe('createCursorIsolatedConfigDir', () => {
  it('reuses a stable directory for the same business session key', () => {
    const userDataPath = mkUserData();
    try {
      const a = createCursorIsolatedConfigDir(process.env, {
        stableKey: 'biz-session-1',
        userDataPath,
      });
      const b = createCursorIsolatedConfigDir(process.env, {
        stableKey: 'biz-session-1',
        userDataPath,
      });
      expect(a.configDir).toBe(b.configDir);
      expect(a.env.CURSOR_CONFIG_DIR).toBe(a.configDir);
      expect(existsSync(join(a.configDir, 'cli-config.json'))).toBe(true);

      const cfg = JSON.parse(readFileSync(join(a.configDir, 'cli-config.json'), 'utf8')) as {
        approvalMode: string;
      };
      expect(cfg.approvalMode).toBe('allowlist');

      // Simulate acp-sessions surviving close/dispose.
      const marker = join(a.configDir, 'acp-sessions', 'keep-me');
      mkdirSync(join(a.configDir, 'acp-sessions'), { recursive: true });
      writeFileSync(marker, 'alive');
      // dispose must NOT wipe the directory (resume needs acp-sessions).
      a.dispose();
      b.dispose();
      expect(existsSync(a.configDir)).toBe(true);
      expect(existsSync(marker)).toBe(true);
      expect(existsSync(join(a.configDir, 'cli-config.json'))).toBe(true);
    } finally {
      rmSync(userDataPath, { recursive: true, force: true });
    }
  });

  it('isolates different business session keys', () => {
    const userDataPath = mkUserData();
    try {
      const a = createCursorIsolatedConfigDir({}, { stableKey: 's-a', userDataPath });
      const b = createCursorIsolatedConfigDir({}, { stableKey: 's-b', userDataPath });
      expect(a.configDir).not.toBe(b.configDir);
    } finally {
      rmSync(userDataPath, { recursive: true, force: true });
    }
  });

  it('places config under injected userDataPath/cursor-acp (not homedir fallback)', () => {
    const userDataPath = mkUserData();
    try {
      const cfg = createCursorIsolatedConfigDir({}, {
        stableKey: 'sess-ud',
        userDataPath,
      });
      expect(cfg.configDir.startsWith(join(userDataPath, 'cursor-acp'))).toBe(true);
      expect(cfg.configDir).toBe(resolveCursorIsolatedConfigDir(userDataPath, 'sess-ud'));
    } finally {
      rmSync(userDataPath, { recursive: true, force: true });
    }
  });

  // http1 是上游对付 h2 stream CANCEL 的逃生阀；写死 false 会让用户在 Cursor
  // 里打开也对 Cindy 会话无效。
  it('inherits the user network config (http1 escape hatch) instead of hardcoding it', () => {
    const userDataPath = mkUserData();
    const userCursorDir = mkUserData();
    try {
      writeFileSync(
        join(userCursorDir, 'cli-config.json'),
        JSON.stringify({ version: 1, network: { useHttp1ForAgent: true } }),
      );
      const cfg = createCursorIsolatedConfigDir(
        { CURSOR_CONFIG_DIR: userCursorDir },
        {
          stableKey: 'net-inherit',
          userDataPath,
          networkConfigReader: readUserNetworkConfigFromEnv,
        },
      );
      const written = JSON.parse(readFileSync(join(cfg.configDir, 'cli-config.json'), 'utf8')) as {
        network: { useHttp1ForAgent: boolean };
        approvalMode: string;
      };
      expect(written.network.useHttp1ForAgent).toBe(true);
      // 权限隔离不受影响：仍强制 allowlist。
      expect(written.approvalMode).toBe('allowlist');
    } finally {
      rmSync(userDataPath, { recursive: true, force: true });
      rmSync(userCursorDir, { recursive: true, force: true });
    }
  });

  it('默认不读取用户来源，注入 reader 时只使用注入值', () => {
    const userDataPath = mkUserData();
    const userCursorDir = mkUserData();
    try {
      writeFileSync(
        join(userCursorDir, 'cli-config.json'),
        JSON.stringify({ version: 1, network: { useHttp1ForAgent: true } }),
      );

      const withoutReader = createCursorIsolatedConfigDir(
        { CURSOR_CONFIG_DIR: userCursorDir },
        { stableKey: 'net-default', userDataPath },
      );
      const defaultConfig = JSON.parse(
        readFileSync(join(withoutReader.configDir, 'cli-config.json'), 'utf8'),
      ) as { network: { useHttp1ForAgent: boolean } };
      expect(defaultConfig.network.useHttp1ForAgent).toBe(false);

      const reader = vi.fn(() => ({ useHttp1ForAgent: true }));
      const withReader = createCursorIsolatedConfigDir(
        { CURSOR_CONFIG_DIR: join(userCursorDir, 'missing') },
        {
          stableKey: 'net-injected',
          userDataPath,
          networkConfigReader: reader,
        },
      );
      const injectedConfig = JSON.parse(
        readFileSync(join(withReader.configDir, 'cli-config.json'), 'utf8'),
      ) as { network: { useHttp1ForAgent: boolean } };
      expect(reader).toHaveBeenCalledOnce();
      expect(reader).toHaveBeenCalledWith({
        CURSOR_CONFIG_DIR: join(userCursorDir, 'missing'),
      });
      expect(injectedConfig.network.useHttp1ForAgent).toBe(true);
    } finally {
      rmSync(userDataPath, { recursive: true, force: true });
      rmSync(userCursorDir, { recursive: true, force: true });
    }
  });

  it('refuses missing userDataPath and never writes under HOME', () => {
    const homeCursorAcp = join(homedir(), '.cindy', 'cursor-acp');
    const before = existsSync(homeCursorAcp);
    expect(() =>
      createCursorIsolatedConfigDir({}, { stableKey: 'no-ud', userDataPath: '' }),
    ).toThrow(/userDataPath/);
    expect(() =>
      // @ts-expect-error intentional: lock the required injection contract
      createCursorIsolatedConfigDir({}, { stableKey: 'no-ud' }),
    ).toThrow(/userDataPath/);
    expect(existsSync(homeCursorAcp)).toBe(before);
  });
});

describe('removeCursorIsolatedConfigDir', () => {
  it('removes only the deleted session dir; leaves sibling sessions intact', () => {
    const userDataPath = mkUserData();
    try {
      const keep = createCursorIsolatedConfigDir({}, {
        stableKey: 'still-active',
        userDataPath,
      });
      const gone = createCursorIsolatedConfigDir({}, {
        stableKey: 'to-delete',
        userDataPath,
      });
      mkdirSync(join(gone.configDir, 'acp-sessions'), { recursive: true });
      writeFileSync(join(gone.configDir, 'acp-sessions', 'x'), 'data');

      removeCursorIsolatedConfigDir(userDataPath, 'to-delete');

      expect(existsSync(gone.configDir)).toBe(false);
      expect(existsSync(keep.configDir)).toBe(true);
      expect(existsSync(join(keep.configDir, 'cli-config.json'))).toBe(true);
    } finally {
      rmSync(userDataPath, { recursive: true, force: true });
    }
  });

  it('is a no-op for blank stableKey (never wipes cursor-acp root)', () => {
    const userDataPath = mkUserData();
    try {
      const keep = createCursorIsolatedConfigDir({}, {
        stableKey: 'keep-me',
        userDataPath,
      });
      removeCursorIsolatedConfigDir(userDataPath, '   ');
      expect(existsSync(keep.configDir)).toBe(true);
    } finally {
      rmSync(userDataPath, { recursive: true, force: true });
    }
  });

  it('does not remove an in-use session when another id is deleted', () => {
    const userDataPath = mkUserData();
    try {
      const active = createCursorIsolatedConfigDir({}, {
        stableKey: 'active-session',
        userDataPath,
      });
      createCursorIsolatedConfigDir({}, { stableKey: 'other-session', userDataPath });

      // Simulate "delete other only" — active must survive for resume.
      removeCursorIsolatedConfigDir(userDataPath, 'other-session');
      expect(existsSync(active.configDir)).toBe(true);
    } finally {
      rmSync(userDataPath, { recursive: true, force: true });
    }
  });
});

describe('cli-config 合并写', () => {
  function readConfig(configDir: string): Record<string, unknown> {
    return JSON.parse(readFileSync(join(configDir, 'cli-config.json'), 'utf8')) as Record<
      string,
      unknown
    >;
  }

  /** 起一次会话 → 上游写回它自己的缓存 → 再起一次会话。 */
  function bootTwice(
    userDataPath: string,
    upstreamWrites: Record<string, unknown>,
    opts: Parameters<typeof createCursorIsolatedConfigDir>[1] = { stableKey: 's', userDataPath: '' },
  ): Record<string, unknown> {
    const first = createCursorIsolatedConfigDir({}, { ...opts, userDataPath });
    const merged = { ...readConfig(first.configDir), ...upstreamWrites };
    writeFileSync(join(first.configDir, 'cli-config.json'), JSON.stringify(merged, null, 2));
    const second = createCursorIsolatedConfigDir({}, { ...opts, userDataPath });
    return readConfig(second.configDir);
  }

  it('keeps upstream-owned state across restarts', () => {
    const userDataPath = mkUserData();
    try {
      const cfg = bootTwice(userDataPath, {
        // 上游把登录态 / 隐私档 / 模型记录都放在同一个文件里；整写会让每次起
        // 会话都退回全冷状态，重新拉一遍。
        authInfo: { email: 'nobody@example.invalid', teamId: 1 },
        privacyCache: { ghostMode: true, privacyMode: 2 },
        modelSelectionHistory: ['grok-4.5'],
      });
      expect(cfg.authInfo).toEqual({ email: 'nobody@example.invalid', teamId: 1 });
      expect(cfg.privacyCache).toEqual({ ghostMode: true, privacyMode: 2 });
      expect(cfg.modelSelectionHistory).toEqual(['grok-4.5']);
    } finally {
      rmSync(userDataPath, { recursive: true, force: true });
    }
  });

  it('forces the security keys back even if upstream widened them', () => {
    const userDataPath = mkUserData();
    try {
      const cfg = bootTwice(userDataPath, {
        approvalMode: 'unrestricted',
        permissions: { allow: ['Bash(rm -rf /)'], deny: [] },
        sandbox: { mode: 'enabled', networkAccess: 'blocked' },
      });
      // unrestricted 会整个屏蔽 session/request_permission；留存的 allow 条目
      // 等于让一次性授权跨重启存活。两者都必须被打回去。
      expect(cfg.approvalMode).toBe('allowlist');
      expect(cfg.permissions).toEqual({ allow: [], deny: [] });
      expect(cfg.sandbox).toEqual({ mode: 'disabled', networkAccess: 'user_config_with_defaults' });
    } finally {
      rmSync(userDataPath, { recursive: true, force: true });
    }
  });

  it('falls back to a full write when the existing config is corrupt', () => {
    const userDataPath = mkUserData();
    try {
      const first = createCursorIsolatedConfigDir({}, { stableKey: 's', userDataPath });
      writeFileSync(join(first.configDir, 'cli-config.json'), '{"broken": ');
      const cfg = readConfig(
        createCursorIsolatedConfigDir({}, { stableKey: 's', userDataPath }).configDir,
      );
      expect(cfg.approvalMode).toBe('allowlist');
      expect(cfg.broken).toBeUndefined();
    } finally {
      rmSync(userDataPath, { recursive: true, force: true });
    }
  });

  it('preseeds the model so session/new comes back already configured', () => {
    const userDataPath = mkUserData();
    try {
      const { configDir } = createCursorIsolatedConfigDir({}, {
        stableKey: 's',
        userDataPath,
        modelSeed: { modelId: 'grok-4.5', parameters: { fast: 'false' } },
      });
      const cfg = readConfig(configDir);
      expect(cfg.model).toMatchObject({ modelId: 'grok-4.5' });
      expect(cfg.selectedModel).toEqual({
        modelId: 'grok-4.5',
        parameters: [{ id: 'fast', value: 'false' }],
      });
      expect(cfg.modelParameters).toEqual({ 'grok-4.5': [{ id: 'fast', value: 'false' }] });
      expect(cfg.hasChangedDefaultModel).toBe(true);
    } finally {
      rmSync(userDataPath, { recursive: true, force: true });
    }
  });

  it('merges the seed into upstream-remembered parameters instead of dropping them', () => {
    const userDataPath = mkUserData();
    try {
      const seed = { modelId: 'grok-4.5', parameters: { fast: 'true' } };
      const cfg = bootTwice(
        userDataPath,
        {
          modelParameters: {
            'grok-4.5': [
              { id: 'effort', value: 'high' },
              { id: 'fast', value: 'false' },
            ],
            'claude-opus-5': [{ id: 'thinking', value: 'true' }],
          },
        },
        { stableKey: 's', userDataPath: '', modelSeed: seed },
      );
      // effort 不预写（id 与拼写随模型家族变），必须留住上游记的那份；
      // 别的模型的记录也不能被这次预写抹掉。
      expect(cfg.modelParameters).toEqual({
        'grok-4.5': [
          { id: 'effort', value: 'high' },
          { id: 'fast', value: 'true' },
        ],
        'claude-opus-5': [{ id: 'thinking', value: 'true' }],
      });
    } finally {
      rmSync(userDataPath, { recursive: true, force: true });
    }
  });
});

describe('clearCursorIsolatedCliConfigs（登出清理）', () => {
  it('clears every session cli-config but keeps acp-sessions intact', () => {
    const userDataPath = mkUserData();
    try {
      const a = createCursorIsolatedConfigDir({}, { stableKey: 'sess-a', userDataPath });
      const b = createCursorIsolatedConfigDir({}, { stableKey: 'sess-b', userDataPath });
      // acp-sessions 是 session/load 的依据，清理绝不能碰它。
      for (const dir of [a.configDir, b.configDir]) {
        mkdirSync(join(dir, 'acp-sessions', 'upstream-id'), { recursive: true });
        writeFileSync(join(dir, 'acp-sessions', 'upstream-id', 'meta.json'), '{}');
      }

      expect(clearCursorIsolatedCliConfigs(userDataPath)).toBe(2);

      for (const dir of [a.configDir, b.configDir]) {
        expect(existsSync(join(dir, 'cli-config.json'))).toBe(false);
        expect(existsSync(join(dir, 'acp-sessions', 'upstream-id', 'meta.json'))).toBe(true);
      }
    } finally {
      rmSync(userDataPath, { recursive: true, force: true });
    }
  });

  it('drops the cached identity so the next session rebuilds a clean config', () => {
    const userDataPath = mkUserData();
    try {
      const first = createCursorIsolatedConfigDir({}, { stableKey: 'sess', userDataPath });
      const withIdentity = {
        ...(JSON.parse(readFileSync(join(first.configDir, 'cli-config.json'), 'utf8')) as Record<
          string,
          unknown
        >),
        authInfo: { email: 'nobody@example.invalid' },
      };
      writeFileSync(join(first.configDir, 'cli-config.json'), JSON.stringify(withIdentity));

      clearCursorIsolatedCliConfigs(userDataPath);
      const second = createCursorIsolatedConfigDir({}, { stableKey: 'sess', userDataPath });
      const cfg = JSON.parse(readFileSync(join(second.configDir, 'cli-config.json'), 'utf8')) as {
        authInfo?: unknown;
        approvalMode: string;
      };
      expect(cfg.authInfo).toBeUndefined();
      expect(cfg.approvalMode).toBe('allowlist');
    } finally {
      rmSync(userDataPath, { recursive: true, force: true });
    }
  });

  it('is a no-op when no cursor session has ever run', () => {
    const userDataPath = mkUserData();
    try {
      expect(clearCursorIsolatedCliConfigs(userDataPath)).toBe(0);
    } finally {
      rmSync(userDataPath, { recursive: true, force: true });
    }
  });
});
