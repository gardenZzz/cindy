import type { RemoteForward, RemoteForwardSpec } from '@cindy/maker-remote-ssh';

interface ProviderForwardEntry {
  pending: Promise<RemoteForward>;
  handle?: RemoteForward;
}

export interface PiRemoteProviderForwardLease {
  ensure(spec: { localUrl: string; remotePort: number }): Promise<void>;
  releaseAll(): Promise<void>;
}

/**
 * Owns the remote-forward handles acquired by one remote transport wrapper
 * (Pi and Claude Code share this — both agents reverse-forward host-owned
 * loopback services into remote sessions via SSH). RemoteHost deduplicates the
 * tunnel but returns one ref-counted handle per call, so an old reattach
 * wrapper cannot release its replacement's handle.
 */
export function createPiRemoteProviderForwardLease(
  ensureRemoteForward: (spec: RemoteForwardSpec) => Promise<RemoteForward>,
): PiRemoteProviderForwardLease {
  const entries = new Map<string, ProviderForwardEntry>();
  let released = false;

  const releaseEntry = async ({ pending, handle }: ProviderForwardEntry): Promise<void> => {
    let resolved = handle;
    if (!resolved) {
      try {
        resolved = await pending;
      } catch {
        return;
      }
    }
    await resolved.close();
  };

  return {
    async ensure(spec) {
      if (released) {
        throw new Error('pi host proxy forward cannot be established after transport cleanup');
      }
      const local = new URL(spec.localUrl);
      const localHost = local.hostname.replace(/^\[|\]$/g, '');
      const localPort = Number(local.port);
      if (
        !['127.0.0.1', '::1', 'localhost'].includes(localHost) ||
        !Number.isInteger(localPort) ||
        localPort <= 0
      ) {
        throw new Error(`pi host proxy forward requires an explicit loopback port: ${spec.localUrl}`);
      }
      const entryId = [`${localHost}:${localPort}`, String(spec.remotePort)].join('\0');
      const existing = entries.get(entryId);
      if (existing) {
        await existing.pending;
        return;
      }

      const pending = ensureRemoteForward({
        localHost,
        localPort,
        preferredRemotePort: spec.remotePort,
        exactRemotePort: true,
      });
      const entry = { pending, handle: undefined as RemoteForward | undefined };
      entries.set(entryId, entry);
      try {
        entry.handle = await pending;
      } catch (error) {
        if (entries.get(entryId) === entry) entries.delete(entryId);
        throw error;
      }
    },

    async releaseAll() {
      if (released) return;
      released = true;
      const ownedEntries = Array.from(entries.values());
      entries.clear();
      await Promise.all(ownedEntries.map(releaseEntry));
    },
  };
}

/** baseUrl 是否指向本机 loopback(与本机 proxy 同判定,远端会话不可达)。
 *  轮 24 CRITICAL-1:startsWith('127.') 会误杀 127.example.com 等合法域名
 *  —— 改为精确 IPv4 loopback 正则(/^127\.\d+\.\d+\.\d+$/)。URL.hostname 已
 *  去括号, ::1 无需再匹配 '[::1]'(保留兼容)。
 *  轮 36 HIGH:与 remote-claude-route.ts 的 isLoopbackUrl 对齐。 */
export function isLoopbackUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return (
      host === 'localhost' ||
      /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ||
      host === '::1' ||
      host === '[::1]'
    );
  } catch {
    return false;
  }
}

/** 能建反向隧道的 loopback host —— 与本模块 lease 的 ensure 校验同口径。
 *  127.0.0.0/8 里的别名地址(127.0.1.1 等)本机通常没绑,不在此列:仍是 loopback,
 *  但建不出隧道,留给调用方的远端 guard 拒绝。 */
export const FORWARDABLE_LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

/** loopback baseUrl → 可用于反向隧道的端口;不可隧道(非 loopback / 别名地址 /
 *  无显式端口)返回 null。端口必须显式:隐式 80/443 在远端绑定要 root。 */
export function loopbackForwardPort(baseUrl: string): number | null {
  if (!isLoopbackUrl(baseUrl)) return null;
  try {
    const parsed = new URL(baseUrl);
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const port = Number(parsed.port);
    if (!FORWARDABLE_LOOPBACK_HOSTS.has(host)) return null;
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

/** URL 串的 host 归一到 127.0.0.1(已是则原样返回,不做任何规范化)。 */
export function toRemoteLoopbackUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.hostname === '127.0.0.1') return url;
  parsed.hostname = '127.0.0.1';
  const next = parsed.toString();
  // URL.toString() 会给裸 origin 补尾斜杠;原串没有就去掉,baseUrl 保持逐字忠实。
  return url.endsWith('/') || !next.endsWith('/') ? next : next.slice(0, -1);
}
