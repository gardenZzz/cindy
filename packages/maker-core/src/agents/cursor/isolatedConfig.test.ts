import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  createCursorIsolatedConfigDir,
  removeCursorIsolatedConfigDir,
  resolveCursorIsolatedConfigDir,
} from './isolatedConfig.js';

describe('createCursorIsolatedConfigDir', () => {
  it('reuses a stable directory for the same business session key', () => {
    const userDataPath = join(tmpdir(), `cindy-iso-${Date.now()}`);
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

    rmSync(userDataPath, { recursive: true, force: true });
  });

  it('isolates different business session keys', () => {
    const userDataPath = join(tmpdir(), `cindy-iso-${Date.now()}-b`);
    const a = createCursorIsolatedConfigDir({}, { stableKey: 's-a', userDataPath });
    const b = createCursorIsolatedConfigDir({}, { stableKey: 's-b', userDataPath });
    expect(a.configDir).not.toBe(b.configDir);
    rmSync(userDataPath, { recursive: true, force: true });
  });

  it('places config under injected userDataPath/cursor-acp (not homedir fallback)', () => {
    const userDataPath = join(tmpdir(), `cindy-iso-ud-${Date.now()}`);
    const cfg = createCursorIsolatedConfigDir({}, {
      stableKey: 'sess-ud',
      userDataPath,
    });
    expect(cfg.configDir.startsWith(join(userDataPath, 'cursor-acp'))).toBe(true);
    expect(cfg.configDir).toBe(resolveCursorIsolatedConfigDir(userDataPath, 'sess-ud'));
    rmSync(userDataPath, { recursive: true, force: true });
  });
});

describe('removeCursorIsolatedConfigDir', () => {
  it('removes only the deleted session dir; leaves sibling sessions intact', () => {
    const userDataPath = join(tmpdir(), `cindy-iso-rm-${Date.now()}`);
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

    rmSync(userDataPath, { recursive: true, force: true });
  });

  it('is a no-op for blank stableKey (never wipes cursor-acp root)', () => {
    const userDataPath = join(tmpdir(), `cindy-iso-blank-${Date.now()}`);
    const keep = createCursorIsolatedConfigDir({}, {
      stableKey: 'keep-me',
      userDataPath,
    });
    removeCursorIsolatedConfigDir(userDataPath, '   ');
    expect(existsSync(keep.configDir)).toBe(true);
    rmSync(userDataPath, { recursive: true, force: true });
  });

  it('does not remove an in-use session when another id is deleted', () => {
    const userDataPath = join(tmpdir(), `cindy-iso-active-${Date.now()}`);
    const active = createCursorIsolatedConfigDir({}, {
      stableKey: 'active-session',
      userDataPath,
    });
    createCursorIsolatedConfigDir({}, { stableKey: 'other-session', userDataPath });

    // Simulate "delete other only" — active must survive for resume.
    removeCursorIsolatedConfigDir(userDataPath, 'other-session');
    expect(existsSync(active.configDir)).toBe(true);

    rmSync(userDataPath, { recursive: true, force: true });
  });
});
