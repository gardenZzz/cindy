import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

import {
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
