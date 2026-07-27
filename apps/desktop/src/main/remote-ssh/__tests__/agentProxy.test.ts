/**
 * agent-proxy 策略层单测。
 *
 * 覆盖:
 *   - buildAgentProxyEnv / buildAgentProxyEnvUppercase / buildAgentProxyMarkerContent
 *     的内容契约 (env 键集、URL 形态、NO_PROXY)
 *   - reconcileCodexAgentProxyEnv 的对账状态机:
 *     marker 一致 → 零副作用; 漂移 → 重写 + pkill; 关闭 → 删除 + pkill
 *   - ensureAgentProxyTunnel 的 pref gate (关 → null, 开 → 建隧道)
 *
 * prefs store 依赖 electron app.getPath, 用 vi.mock 替换; RemoteHost 用
 * 最小 fake (exec 脚本断言 + ensureRemoteForward stub)。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── electron mock: prefs store 落盘到内存 Map ────────────────────────────────
let prefsFileContent: string | null = null;
vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/cindy-test-userdata',
  },
}));

// fs sync API 被 prefs store 直接用; 用内存实现替身。
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: () => prefsFileContent != null,
      readFileSync: () => prefsFileContent ?? '',
      writeFileSync: (_p: string, content: string) => {
        prefsFileContent = content;
      },
      renameSync: () => {},
      unlinkSync: () => {
        prefsFileContent = null;
      },
    },
  };
});

import {
  buildAgentProxyEnv,
  buildAgentProxyEnvUppercase,
  buildAgentProxyMarkerContent,
  ensureAgentProxyTunnel,
  reconcileCodexAgentProxyEnv,
} from '../agent-proxy';
import {
  getSshHostAgentProxy,
  getSshHostAutoConnect,
  setSshHostAgentProxy,
  setSshHostAutoConnect,
} from '../ssh-host-prefs-store';

interface ExecCall {
  cmd: string;
  input?: string;
}

/** 最小 RemoteHost fake: 记录 exec, cat/rm marker + pkill 走脚本内容断言。 */
function makeFakeHost(opts: { marker?: string | null; remotePort?: number } = {}) {
  const state = {
    marker: opts.marker ?? null,
    execCalls: [] as ExecCall[],
    pkillCount: 0,
    forwards: [] as Array<{ localHost: string; localPort: number; remotePort: number }>,
  };
  const host = {
    id: 'test-host',
    async exec(cmd: string, execOpts?: { input?: string }) {
      state.execCalls.push({ cmd, input: execOpts?.input });
      if (cmd.includes('cat "') && cmd.includes('agent-proxy.env')) {
        return { stdout: state.marker ?? '', stderr: '', exitCode: 0, signal: null };
      }
      if (cmd.includes('cat > "') && cmd.includes('agent-proxy.env')) {
        state.marker = (execOpts?.input ?? '').trim();
        return { stdout: '', stderr: '', exitCode: 0, signal: null };
      }
      if (cmd.includes('rm -f "') && cmd.includes('agent-proxy.env')) {
        state.marker = null;
        return { stdout: '', stderr: '', exitCode: 0, signal: null };
      }
      if (cmd.includes('pkill')) {
        state.pkillCount += 1;
        return { stdout: '', stderr: '', exitCode: 0, signal: null };
      }
      return { stdout: '', stderr: '', exitCode: 0, signal: null };
    },
    async ensureRemoteForward(spec: { localHost: string; localPort: number }) {
      const remotePort = opts.remotePort ?? 17893;
      state.forwards.push({ ...spec, remotePort });
      return { remotePort, close: async () => {} };
    },
    async closeAllRemoteForwards() {
      state.forwards = [];
    },
    async closeRemoteForward(localHost: string, localPort: number) {
      state.forwards = state.forwards.filter(
        (f) => !(f.localHost === localHost && f.localPort === localPort),
      );
    },
    listRemoteForwards() {
      return state.forwards.map((f) => ({ ...f, armed: true }));
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { host: host as any, state };
}

const PREF = { enabled: true, localHost: '127.0.0.1', localPort: 7890 };

beforeEach(() => {
  prefsFileContent = null;
});

describe('buildAgentProxyEnv', () => {
  it('builds dual-case proxy env pointing at the tunnel port', () => {
    const env = buildAgentProxyEnv(17893);
    expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:17893');
    expect(env.HTTP_PROXY).toBe('http://127.0.0.1:17893');
    expect(env.https_proxy).toBe('http://127.0.0.1:17893');
    expect(env.http_proxy).toBe('http://127.0.0.1:17893');
    expect(env.NO_PROXY).toContain('localhost');
    expect(env.no_proxy).toContain('127.0.0.1');
  });

  it('uppercase-only variant satisfies the env-block gatekeeper', () => {
    const env = buildAgentProxyEnvUppercase(17893);
    for (const key of Object.keys(env)) {
      expect(key).toMatch(/^[A-Z_][A-Z0-9_]*$/);
    }
    expect(Object.keys(env)).toEqual(['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY']);
  });
});

describe('buildAgentProxyMarkerContent', () => {
  it('is a sourceable shell snippet with the tunnel URL', () => {
    const content = buildAgentProxyMarkerContent(18000);
    expect(content).toContain("export HTTPS_PROXY='http://127.0.0.1:18000'");
    expect(content).toContain("export https_proxy='http://127.0.0.1:18000'");
    expect(content).toContain("export NO_PROXY='localhost,127.0.0.1,::1'");
    expect(content.endsWith('\n')).toBe(true);
  });
});

describe('ensureAgentProxyTunnel', () => {
  it('returns null when the pref is off', async () => {
    const { host, state } = makeFakeHost();
    const result = await ensureAgentProxyTunnel(host);
    expect(result).toBeNull();
    expect(state.forwards).toHaveLength(0);
  });

  it('opens the forward to the pref target when enabled', async () => {
    setSshHostAgentProxy('test-host', PREF);
    const { host, state } = makeFakeHost();
    const result = await ensureAgentProxyTunnel(host);
    expect(result).toEqual({ remotePort: 17893 });
    expect(state.forwards).toEqual([{ localHost: '127.0.0.1', localPort: 7890, remotePort: 17893 }]);
  });

  it('closes stale forwards whose target no longer matches the pref (review R5)', async () => {
    // pref 目标被编辑 (7890 → 1080): 旧目标的 forward 必须拆掉, 否则残留并
    // 随重连 re-arm, 远端多暴露一个隧道口。
    setSshHostAgentProxy('test-host', PREF);
    const { host, state } = makeFakeHost();
    await ensureAgentProxyTunnel(host);
    expect(state.forwards).toHaveLength(1);

    setSshHostAgentProxy('test-host', { ...PREF, localPort: 1080 });
    const result = await ensureAgentProxyTunnel(host);
    expect(result).toEqual({ remotePort: 17893 });
    // 旧 7890 已拆, 只剩新 1080。
    expect(state.forwards).toEqual([{ localHost: '127.0.0.1', localPort: 1080, remotePort: 17893 }]);
  });
});

describe('reconcileCodexAgentProxyEnv', () => {
  it('no-ops when the marker already matches the desired content', async () => {
    setSshHostAgentProxy('test-host', PREF);
    const desired = buildAgentProxyMarkerContent(17893).trim();
    const { host, state } = makeFakeHost({ marker: desired });
    const result = await reconcileCodexAgentProxyEnv(host);
    expect(result).toEqual({ markerChanged: false, daemonRestarted: false });
    expect(state.pkillCount).toBe(0);
  });

  it('writes the marker and kills the daemon when drifted', async () => {
    setSshHostAgentProxy('test-host', PREF);
    const { host, state } = makeFakeHost({ marker: null });
    const result = await reconcileCodexAgentProxyEnv(host);
    expect(result).toEqual({ markerChanged: true, daemonRestarted: true });
    expect(state.marker).toBe(buildAgentProxyMarkerContent(17893).trim());
    expect(state.pkillCount).toBe(1);
  });

  it('deletes the marker and kills the daemon when the pref is off', async () => {
    // 模块级 prefs cache 跨用例共享 — 显式清除, 模拟 "pref 关闭" 场景。
    setSshHostAgentProxy('test-host', null);
    const { host, state } = makeFakeHost({ marker: "export HTTPS_PROXY='http://127.0.0.1:17893'" });
    const result = await reconcileCodexAgentProxyEnv(host);
    expect(result).toEqual({ markerChanged: true, daemonRestarted: true });
    expect(state.marker).toBeNull();
    expect(state.pkillCount).toBe(1);
  });

  it('leaves a missing marker alone when the pref is off', async () => {
    setSshHostAgentProxy('test-host', null);
    const { host, state } = makeFakeHost({ marker: null });
    const result = await reconcileCodexAgentProxyEnv(host);
    expect(result).toEqual({ markerChanged: false, daemonRestarted: false });
    expect(state.pkillCount).toBe(0);
  });
});

describe('ssh-host-prefs-store agentProxy', () => {
  it('round-trips an enabled pref', () => {
    setSshHostAgentProxy('h1', PREF);
    expect(getSshHostAgentProxy('h1')).toEqual(PREF);
  });

  it('returns null for disabled / cleared / unknown hosts', () => {
    setSshHostAgentProxy('h1', { ...PREF, enabled: false });
    expect(getSshHostAgentProxy('h1')).toBeNull();
    setSshHostAgentProxy('h2', PREF);
    setSshHostAgentProxy('h2', null);
    expect(getSshHostAgentProxy('h2')).toBeNull();
    expect(getSshHostAgentProxy('never-set')).toBeNull();
  });

  it('keeps autoConnect when writing agentProxy and vice versa', () => {
    // 双向共存回归 (review: PR #715 五轮审核 P2 — 原测试只写了两次 agentProxy,
    // 没真正交叉 autoConnect): prefs 是同一 JSON 文件里的 sibling 字段,
    // 任一侧写入不得把另一侧冲掉。
    setSshHostAutoConnect('h1', true);
    setSshHostAgentProxy('h1', PREF);
    expect(getSshHostAutoConnect('h1')).toBe(true);
    expect(getSshHostAgentProxy('h1')).toEqual(PREF);
    // 反向: 先写 agentProxy 再改 autoConnect, agentProxy 不丢。
    setSshHostAutoConnect('h1', false);
    expect(getSshHostAgentProxy('h1')).toEqual(PREF);
    expect(getSshHostAutoConnect('h1')).toBe(false);
    // 清 agentProxy 不影响 autoConnect。
    setSshHostAutoConnect('h1', true);
    setSshHostAgentProxy('h1', null);
    expect(getSshHostAgentProxy('h1')).toBeNull();
    expect(getSshHostAutoConnect('h1')).toBe(true);
  });

  it('rejects malformed prefs at write time', () => {
    expect(() =>
      setSshHostAgentProxy('h1', { enabled: true, localHost: 'bad host', localPort: 7890 }),
    ).toThrow(/invalid agentProxy/);
    expect(() =>
      setSshHostAgentProxy('h1', { enabled: true, localHost: '127.0.0.1', localPort: 0 }),
    ).toThrow(/invalid agentProxy/);
  });
});
