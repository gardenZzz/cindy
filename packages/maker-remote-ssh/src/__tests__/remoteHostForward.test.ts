/**
 * RemoteHost remote forwarding (ssh -R 等价物) 测试。
 *
 * 用 fake ssh2 Client (EventEmitter + forwardIn/unforwardIn) 注入私有字段,
 * 本地端用真实 net server (127.0.0.1 回环) 验证字节 pipe:
 *   - 首选端口绑定 / 端口冲突顺延 / 全部失败时报错提及 AllowTcpForwarding
 *   - 'tcp connection' 分发到正确的 forward 并双向 pipe
 *   - 本地目标不可达时只断 channel 不炸进程
 *   - ensure 幂等 / close 调 unforwardIn
 *   - 断线重连 re-arm: 愿望保留、端口变化触发 onRearmed
 */

import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { Duplex, PassThrough } from 'node:stream';
import net from 'node:net';

import { RemoteHost, DEFAULT_REMOTE_FORWARD_PORT_BASE } from '../RemoteHost.js';
import type { HostConfig } from '../types.js';

const HOST_CONFIG: HostConfig = {
  id: 'test-host',
  hostname: '10.0.0.1',
  port: 22,
  user: 'deploy',
  authMethod: 'agent',
  source: 'manual',
};

const noopLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

interface ForwardInCall { addr: string; port: number }

/** 可按端口决定成败的 fake ssh2 Client。 */
class FakeClient extends EventEmitter {
  forwardInCalls: ForwardInCall[] = [];
  unforwardInCalls: ForwardInCall[] = [];
  /** 返回 false 的端口 forwardIn 失败 (模拟被占用 / sshd 拒绝)。 */
  constructor(private readonly allowPort: (port: number) => boolean = () => true) {
    super();
  }
  forwardIn(addr: string, port: number, cb: (err: Error | undefined, port: number) => void): void {
    this.forwardInCalls.push({ addr, port });
    queueMicrotask(() => {
      if (this.allowPort(port)) cb(undefined, port);
      else cb(new Error('Unable to bind'), 0);
    });
  }
  unforwardIn(addr: string, port: number, cb: () => void): void {
    this.unforwardInCalls.push({ addr, port });
    queueMicrotask(() => cb());
  }
}

interface FakeChannelBundle {
  channel: Duplex & { close: () => void };
  /** test 写入 → channel readable → 本地 sock (模拟远端发来的字节)。 */
  fromRemote: PassThrough;
  /** 本地 sock 写入 → test 读出 (模拟要送回远端的字节)。 */
  toRemote: PassThrough;
  closed: () => boolean;
}

function makeFakeChannel(): FakeChannelBundle {
  const fromRemote = new PassThrough();
  const toRemote = new PassThrough();
  let closed = false;
  // 手工拼 Duplex (@types/node 没有 {readable,writable} pair overload 的类型):
  // readable 侧由 fromRemote 推, writable 侧落进 toRemote 供断言。
  const channel = new Duplex({
    read() {},
    write(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void) {
      if (toRemote.write(chunk)) cb();
      else toRemote.once('drain', () => cb());
    },
  }) as Duplex & { close: () => void };
  fromRemote.on('data', (chunk: Buffer) => channel.push(chunk));
  fromRemote.on('end', () => channel.push(null));
  channel.close = () => {
    if (closed) return;
    closed = true;
    channel.destroy();
  };
  return { channel, fromRemote, toRemote, closed: () => closed };
}

function makeReadyHost(client: FakeClient): RemoteHost {
  const host = new RemoteHost(HOST_CONFIG, { logger: noopLogger });
  (host as unknown as { status: string }).status = 'ready';
  (host as unknown as { client: unknown }).client = client;
  return host;
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 10));
}

/** 起一个在 127.0.0.1 随机端口的 echo server, 返回端口与关闭函数。 */
async function startEchoServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = net.createServer((sock) => sock.pipe(sock));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('RemoteHost remote forwarding', () => {
  it('arms forwardIn on the preferred port and lists it as armed', async () => {
    const client = new FakeClient();
    const host = makeReadyHost(client);
    const fwd = await host.ensureRemoteForward({ localHost: '127.0.0.1', localPort: 7890 });

    expect(fwd.remotePort).toBe(DEFAULT_REMOTE_FORWARD_PORT_BASE);
    expect(client.forwardInCalls).toEqual([
      { addr: '127.0.0.1', port: DEFAULT_REMOTE_FORWARD_PORT_BASE },
    ]);
    expect(host.listRemoteForwards()).toEqual([
      {
        localHost: '127.0.0.1',
        localPort: 7890,
        remotePort: DEFAULT_REMOTE_FORWARD_PORT_BASE,
        armed: true,
      },
    ]);
  });

  it('falls back to the next candidate port when the preferred one is taken', async () => {
    const client = new FakeClient((port) => port !== DEFAULT_REMOTE_FORWARD_PORT_BASE);
    const host = makeReadyHost(client);
    const fwd = await host.ensureRemoteForward({ localHost: '127.0.0.1', localPort: 7890 });

    expect(fwd.remotePort).toBe(DEFAULT_REMOTE_FORWARD_PORT_BASE + 1);
    expect(client.forwardInCalls.map((c) => c.port)).toEqual([
      DEFAULT_REMOTE_FORWARD_PORT_BASE,
      DEFAULT_REMOTE_FORWARD_PORT_BASE + 1,
    ]);
  });

  it('throws an actionable error when every candidate port fails', async () => {
    const client = new FakeClient(() => false);
    const host = makeReadyHost(client);
    await expect(
      host.ensureRemoteForward({ localHost: '127.0.0.1', localPort: 7890 }),
    ).rejects.toThrow(/AllowTcpForwarding/);
  });

  it('rejects invalid local targets before touching ssh', async () => {
    const host = makeReadyHost(new FakeClient());
    await expect(
      host.ensureRemoteForward({ localHost: 'bad host', localPort: 7890 }),
    ).rejects.toThrow(/localHost/);
    await expect(
      host.ensureRemoteForward({ localHost: '127.0.0.1', localPort: 0 }),
    ).rejects.toThrow(/localPort/);
  });

  it('is idempotent for the same local target (no duplicate forwardIn)', async () => {
    const client = new FakeClient();
    const host = makeReadyHost(client);
    const a = await host.ensureRemoteForward({ localHost: '127.0.0.1', localPort: 7890 });
    const b = await host.ensureRemoteForward({ localHost: '127.0.0.1', localPort: 7890 });
    expect(a.remotePort).toBe(b.remotePort);
    expect(client.forwardInCalls).toHaveLength(1);
  });

  it('pipes a forwarded connection to the local target and back', async () => {
    const echo = await startEchoServer();
    try {
      const client = new FakeClient();
      const host = makeReadyHost(client);
      const fwd = await host.ensureRemoteForward({ localHost: '127.0.0.1', localPort: echo.port });

      const fake = makeFakeChannel();
      client.emit(
        'tcp connection',
        { srcIP: '127.0.0.1', srcPort: 55000, destIP: '127.0.0.1', destPort: fwd.remotePort },
        () => fake.channel,
        () => { throw new Error('unexpected reject'); },
      );
      fake.fromRemote.write('ping-through-tunnel');
      await flush();

      // echo server 原样弹回 → 应出现在要送回远端的流里。
      expect(fake.toRemote.read()?.toString()).toBe('ping-through-tunnel');
      fake.channel.close();
    } finally {
      await echo.close();
    }
  });

  it('closes the channel (no crash) when the local target is unreachable', async () => {
    // 先占一个端口再释放, 拿到一个几乎必然拒连的端口。
    const probe = await startEchoServer();
    const deadPort = probe.port;
    await probe.close();

    const client = new FakeClient();
    const host = makeReadyHost(client);
    const fwd = await host.ensureRemoteForward({ localHost: '127.0.0.1', localPort: deadPort });

    const fake = makeFakeChannel();
    client.emit(
      'tcp connection',
      { srcIP: '127.0.0.1', srcPort: 55001, destIP: '127.0.0.1', destPort: fwd.remotePort },
      () => fake.channel,
      () => { throw new Error('unexpected reject'); },
    );
    // ECONNREFUSED 是异步的; 等它发生。
    await flush();
    expect(fake.closed()).toBe(true);
  });

  it('rejects connections to unknown destPorts', async () => {
    const client = new FakeClient();
    const host = makeReadyHost(client);
    await host.ensureRemoteForward({ localHost: '127.0.0.1', localPort: 7890 });

    let rejected = false;
    client.emit(
      'tcp connection',
      { srcIP: '127.0.0.1', srcPort: 55002, destIP: '127.0.0.1', destPort: 1 },
      () => { throw new Error('unexpected accept'); },
      () => { rejected = true; },
    );
    expect(rejected).toBe(true);
  });

  it('close() unforwards on the live client and drops the record', async () => {
    const client = new FakeClient();
    const host = makeReadyHost(client);
    const fwd = await host.ensureRemoteForward({ localHost: '127.0.0.1', localPort: 7890 });
    await fwd.close();

    expect(client.unforwardInCalls).toEqual([
      { addr: '127.0.0.1', port: DEFAULT_REMOTE_FORWARD_PORT_BASE },
    ]);
    expect(host.listRemoteForwards()).toEqual([]);
  });

  it('re-arms on reconnect and reports a changed port via onRearmed', async () => {
    const client1 = new FakeClient();
    const host = makeReadyHost(client1);
    let rearmed: number | null = null;
    const fwd = await host.ensureRemoteForward({
      localHost: '127.0.0.1',
      localPort: 7890,
      onRearmed: (port) => { rearmed = port; },
    });
    expect(fwd.remotePort).toBe(DEFAULT_REMOTE_FORWARD_PORT_BASE);

    // 模拟断线重连: 标记 disarm (handlePostReadyClose 路径) 并换上新 client,
    // 新连接上原端口已被别人占 → 应顺延并回调 onRearmed。
    (host as unknown as { markForwardsDisarmed(): void }).markForwardsDisarmed();
    const client2 = new FakeClient((port) => port !== DEFAULT_REMOTE_FORWARD_PORT_BASE);
    (host as unknown as { client: unknown }).client = client2;
    await (host as unknown as { rearmForwards(): Promise<void> }).rearmForwards();

    expect(fwd.remotePort).toBe(DEFAULT_REMOTE_FORWARD_PORT_BASE + 1);
    expect(rearmed).toBe(DEFAULT_REMOTE_FORWARD_PORT_BASE + 1);
    expect(host.listRemoteForwards()[0]?.armed).toBe(true);
  });

  it('keeps the wish when re-arm fails, without throwing (logged only)', async () => {
    const client1 = new FakeClient();
    const host = makeReadyHost(client1);
    await host.ensureRemoteForward({ localHost: '127.0.0.1', localPort: 7890 });

    (host as unknown as { markForwardsDisarmed(): void }).markForwardsDisarmed();
    const client2 = new FakeClient(() => false);
    (host as unknown as { client: unknown }).client = client2;
    await (host as unknown as { rearmForwards(): Promise<void> }).rearmForwards();

    const listed = host.listRemoteForwards();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.armed).toBe(false);
  });

  it('defers arming until connect when the host is not ready', async () => {
    const client = new FakeClient();
    const host = new RemoteHost(HOST_CONFIG, { logger: noopLogger });
    // disconnected 状态: 只登记愿望, 不碰 ssh。
    const fwdPromise = host.ensureRemoteForward({ localHost: '127.0.0.1', localPort: 7890 });
    await expect(fwdPromise).resolves.toBeDefined();
    expect(client.forwardInCalls).toHaveLength(0);

    // 连接建立 → doConnect onReady 路径的 rearmForwards 把它挂上。
    (host as unknown as { status: string }).status = 'ready';
    (host as unknown as { client: unknown }).client = client;
    await (host as unknown as { rearmForwards(): Promise<void> }).rearmForwards();
    expect(client.forwardInCalls).toHaveLength(1);
  });
});
