/**
 * agent-proxy —— 「Agent 流量经 SSH 隧道走本地 Proxy」的策略层。
 *
 * 链路与职责切分:
 *
 *   远端 codex daemon / claude CLI
 *     │  HTTPS_PROXY=http://127.0.0.1:<remotePort>   (env 注入)
 *     ▼
 *   远端 127.0.0.1:<remotePort>                     (sshd remote forwarding, ssh -R)
 *     │  SSH 连接内多路复用 channel                    (RemoteHost.ensureRemoteForward)
 *     ▼
 *   本机 pipe → 用户自己的本地 Proxy (如 127.0.0.1:7890)
 *
 * Cindy 不提供 Proxy, 只提供隧道。域名解析发生在用户 Proxy 那一端
 * (HTTP CONNECT 语义), 远端完全不需要能解 chatgpt.com / api.anthropic.com。
 *
 * 两个 agent 的 env 注入方式不同:
 *   - claude-code: cc-mgr daemon 按 session spawn SDK, startParams.env 每
 *     次会话重建 — 直接在 remoteCcQueryFactory 里 merge, 即时生效。
 *   - codex: app-server daemon 是远端常驻进程, env 只能在 daemon 启动时
 *     生效。所以写一个 marker 文件 ($INSTALL_ROOT/agent-proxy.env),
 *     daemon wrapper 启动前 source 它; marker 漂移时 pkill daemon
 *     (daemon version 探活失败 → 下次 transport bootstrap 重新拉起,
 *     与 auth sync 的 daemonRestart 同套路)。
 */

import {
  REMOTE_AGENT_PROXY_ENV_PATH,
  REMOTE_INSTALL_ROOT,
  type RemoteHost,
} from '@cindy/maker-remote-ssh';

import { createLogger } from '../logger.js';
import { getSshHostAgentProxy } from './ssh-host-prefs-store.js';

const log = createLogger('remote-ssh/agent-proxy');

/** UI 展示用的隧道实时状态 (内存态, 不持久化)。 */
export interface AgentProxyTunnelState {
  active: boolean;
  remotePort?: number;
  lastError?: string;
}

const tunnelStates = new Map<string, AgentProxyTunnelState>();

export function getAgentProxyTunnelState(hostId: string): AgentProxyTunnelState | null {
  return tunnelStates.get(hostId) ?? null;
}

/** host 删除时同步清掉内存态。 */
export function clearAgentProxyTunnelState(hostId: string): void {
  tunnelStates.delete(hostId);
}

// broadcast 由 index.ts 注入 (避免循环依赖): 隧道状态变化后推一版
// status snapshot 给 renderer, HostSnapshotWithPrefs 会带上最新 tunnel state。
let broadcaster: ((hostId: string) => void) | null = null;
export function initAgentProxy(deps: { broadcast: (hostId: string) => void }): void {
  broadcaster = deps.broadcast;
}
function emitState(hostId: string): void {
  try {
    broadcaster?.(hostId);
  } catch { /* broadcast must not throw into ssh paths */ }
}

/* ============================== env 构造 ============================== */

/**
 * 注入远端 agent 进程的代理 env。大小写两份: Rust (reqwest) / Node /
 * Go / curl 对 HTTPS_PROXY vs https_proxy 的读取习惯不一致, 全给最稳。
 * NO_PROXY 只排除 loopback — 用户自己的 Proxy 规则决定内网域名直连与否,
 * 那是 Proxy 软件的职责, 不是我们的。
 */
export function buildAgentProxyEnv(remotePort: number): Record<string, string> {
  const url = `http://127.0.0.1:${remotePort}`;
  const noProxy = 'localhost,127.0.0.1,::1';
  return {
    HTTPS_PROXY: url,
    HTTP_PROXY: url,
    NO_PROXY: noProxy,
    https_proxy: url,
    http_proxy: url,
    no_proxy: noProxy,
  };
}

/**
 * 仅大写版本 — env-block.ts 的 gatekeeper 拒小写 key (防 stdin 协议注入),
 * one-shot 的 envBlock 路径只能拿大写; claude/codex 都认大写。
 */
export function buildAgentProxyEnvUppercase(remotePort: number): Record<string, string> {
  const url = `http://127.0.0.1:${remotePort}`;
  return {
    HTTPS_PROXY: url,
    HTTP_PROXY: url,
    NO_PROXY: 'localhost,127.0.0.1,::1',
  };
}

/** codex daemon wrapper source 的 marker 文件内容。 */
export function buildAgentProxyMarkerContent(remotePort: number): string {
  const url = `http://127.0.0.1:${remotePort}`;
  return [
    '# Written by Cindy — agent proxy tunnel env. Sourced by the codex daemon wrapper.',
    `export HTTPS_PROXY='${url}'`,
    `export HTTP_PROXY='${url}'`,
    `export NO_PROXY='localhost,127.0.0.1,::1'`,
    `export https_proxy='${url}'`,
    `export http_proxy='${url}'`,
    `export no_proxy='localhost,127.0.0.1,::1'`,
    '',
  ].join('\n');
}

/* ============================== 隧道管理 ============================== */

/**
 * pref 开启时确保隧道在跑, 返回远端端口; pref 关闭返回 null。
 * host 必须 ready (调用方保证); arm 失败抛错并记录到 tunnel state。
 */
export async function ensureAgentProxyTunnel(
  host: RemoteHost,
): Promise<{ remotePort: number } | null> {
  const pref = getSshHostAgentProxy(host.id);
  if (!pref) return null;
  try {
    const fwd = await host.ensureRemoteForward({
      localHost: pref.localHost,
      localPort: pref.localPort,
    });
    tunnelStates.set(host.id, { active: true, remotePort: fwd.remotePort });
    emitState(host.id);
    return { remotePort: fwd.remotePort };
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    tunnelStates.set(host.id, { active: false, lastError: msg });
    emitState(host.id);
    throw err;
  }
}

/**
 * claude-code session 路径: pref 开启 → 确保隧道 + 返回要 merge 进
 * startParams.env 的代理 env; 关闭 → null (调用方原样透传 startParams)。
 */
export async function getRemoteAgentProxyEnv(
  host: RemoteHost,
): Promise<Record<string, string> | null> {
  const tunnel = await ensureAgentProxyTunnel(host);
  if (!tunnel) return null;
  return buildAgentProxyEnv(tunnel.remotePort);
}

/** 拆除本 host 的所有 forward (pref 关闭时调用)。 */
async function closeAllForwards(host: RemoteHost): Promise<void> {
  try {
    await host.closeAllRemoteForwards();
  } catch (err) {
    log.warn('close remote forwards failed (best-effort)', {
      hostId: host.id,
      error: String((err as Error)?.message ?? err),
    });
  }
}

/* ============================== codex daemon env marker ============================== */

async function readRemoteMarker(host: RemoteHost): Promise<string | null> {
  const result = await host.exec(
    `bash -c 'cat "${REMOTE_AGENT_PROXY_ENV_PATH}" 2>/dev/null || true'`,
    { timeoutMs: 10_000, label: 'read-agent-proxy-marker' },
  );
  const content = result.stdout.trim();
  return content ? content : null;
}

async function writeRemoteMarker(host: RemoteHost, content: string | null): Promise<void> {
  if (content == null) {
    await host.exec(`bash -c 'rm -f "${REMOTE_AGENT_PROXY_ENV_PATH}"'`, {
      timeoutMs: 10_000,
      label: 'delete-agent-proxy-marker',
    });
    return;
  }
  // mkdir -p 兜底: install root 通常在 codex 安装时已建, 但 proxy-only
  // 场景 (只开了 claude 没装 codex) 目录可能还不存在。内容走 stdin,
  // 不进 cmd (与 repo 的 secret-hygiene 惯例一致, 虽然 marker 本身无密钥)。
  await host.exec(
    `bash -c 'mkdir -p "${REMOTE_INSTALL_ROOT}" && cat > "${REMOTE_AGENT_PROXY_ENV_PATH}"'`,
    { timeoutMs: 10_000, label: 'write-agent-proxy-marker', input: content },
  );
}

/**
 * pkill 远端 codex app-server daemon (含 sock proxy 子进程)。
 *
 * 从 SYNC_CODEX_AUTH handler 抽出的共享实现 — daemon 启动时 in-memory 缓存
 * auth.json / env, 不支持 hot-reload; 变了只能杀, 下次探活失败自动 bootstrap。
 *
 * pattern 设计 (与 auth sync 原实现一致):
 * - 匹配 `codex app-server` 两词而非 `codex app-server daemon`: daemon 主进程
 *   的 cmdline 是 `codex app-server --remote-control --listen unix://`, 不含
 *   "daemon" 字 (只有 worker 子进程 cmdline 含 `daemon pid-update-loop`)。
 *   早期 pattern 带 daemon 只杀到 worker, 主进程活着继续用旧 auth/env。
 * - 匹配整条 cmdline 同时含 `.xdt-server` 和 `codex app-server` — 只杀我们
 *   自己装的 daemon, 不误伤用户自己装在别处的 codex app-server。一次性
 *   `codex --print` / `codex exec` 不命中。短暂探活命令
 *   `codex app-server daemon version` 理论命中但只跑几毫秒, 即使命中也无害
 *   (desktop 探活失败会自动 bootstrap)。
 * - `[c]odex` 字符类 trick: pkill 自己的 cmdline 字面含 `[c]odex` (带方括号),
 *   不匹配连续 5 字符 `codex`, 不会自杀。
 * - `id -un` 而非 `$USER` 取用户名 + `-u` 限定只杀当前 SSH user 的进程。
 * - rc=0 杀到 / rc=1 没匹配 (从没启过 daemon, 也算成功) / rc>1 真错误。
 */
export async function killRemoteCodexDaemon(
  host: RemoteHost,
): Promise<{ ok: true } | { ok: false; reason: 'pkill_failed'; detail?: string }> {
  const killScript = `
USER_NAME=$(id -un 2>/dev/null)
if [ -z "$USER_NAME" ]; then echo "id -un returned empty" >&2; exit 2; fi
pkill -u "$USER_NAME" -f '\\.xdt-server.*[c]odex app-server'
rc=$?
case "$rc" in
  0|1) exit 0 ;;
  *) echo "pkill rc=$rc" >&2; exit "$rc" ;;
esac
`;
  try {
    const result = await host.exec(`bash -c ${shellQuote(killScript)}`, {
      timeoutMs: 5_000,
      label: 'kill-codex-daemon',
    });
    if (result.exitCode !== 0) {
      const detail = result.stderr.trim().slice(0, 200);
      log.warn('failed to kill remote codex daemon', { hostId: host.id, exitCode: result.exitCode, stderr: detail });
      return { ok: false, reason: 'pkill_failed', detail };
    }
    return { ok: true };
  } catch (err) {
    const detail = String((err as Error).message ?? err);
    log.warn('failed to kill remote codex daemon (exec error)', { hostId: host.id, error: detail });
    return { ok: false, reason: 'pkill_failed', detail };
  }
}

/**
 * codex 路径的 env 对账: 比较远端 marker 与期望值, 漂移则重写 marker +
 * pkill daemon (下次 transport bootstrap 时 daemon version 探活失败 →
 * 重新 bootstrap, wrapper source 新 marker, env 生效)。
 *
 * 调用点:
 *   1. codex-remote-transport bootstrap 的 beforeDaemonProbe (每个新
 *      app-server host 建立前) — 兜底所有路径 (app 重启 / 端口变化 /
 *      远端被别的客户端动过)。
 *   2. pref 变更 / host ready 的 applyAgentProxyForHost — 即时生效。
 *
 * marker 一致时零副作用 (1 次 cat RTT)。pkill 失败不抛错 — marker 已写,
 * 下次 daemon 自然重启时也会生效, 这里只降级为 warn。
 */
export async function reconcileCodexAgentProxyEnv(
  host: RemoteHost,
): Promise<{ markerChanged: boolean; daemonRestarted: boolean }> {
  const pref = getSshHostAgentProxy(host.id);
  let desired: string | null = null;
  if (pref) {
    const tunnel = await ensureAgentProxyTunnel(host);
    if (!tunnel) throw new Error('agentProxy pref enabled but tunnel refused to start');
    desired = buildAgentProxyMarkerContent(tunnel.remotePort);
  }

  const current = await readRemoteMarker(host);
  if (current === (desired ? desired.trim() : null)) {
    return { markerChanged: false, daemonRestarted: false };
  }

  log.info('codex agent-proxy env marker drifted, rewriting + restarting daemon', {
    hostId: host.id,
    enabled: pref != null,
  });
  await writeRemoteMarker(host, desired);
  const kill = await killRemoteCodexDaemon(host);
  return { markerChanged: true, daemonRestarted: kill.ok };
}

/**
 * host ready / pref 变更后的统一应用入口 (幂等):
 *   - pref 开 → 建隧道 + codex marker 对账
 *   - pref 关 → 拆隧道 + 清 marker (有残留 daemon 时重启之)
 * 失败不抛 — 状态落 tunnelStates 给 UI, session 路径会再显式重试并拿到错误。
 */
export async function applyAgentProxyForHost(host: RemoteHost): Promise<void> {
  const pref = getSshHostAgentProxy(host.id);
  try {
    if (!pref) {
      await closeAllForwards(host);
      await reconcileCodexAgentProxyEnv(host);
      tunnelStates.delete(host.id);
      emitState(host.id);
      return;
    }
    await ensureAgentProxyTunnel(host);
    await reconcileCodexAgentProxyEnv(host);
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    log.warn('apply agent-proxy failed (will retry on next session)', { hostId: host.id, error: msg });
    tunnelStates.set(host.id, { active: false, lastError: msg });
    emitState(host.id);
  }
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
