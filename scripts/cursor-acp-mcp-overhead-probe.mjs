#!/usr/bin/env node
/**
 * cursor-acp-mcp-overhead-probe.mjs —— 一次性调试探针，**不是产品代码**。
 *
 * issue #35（T3）：测 Orca worker 注入 MCP servers 后 ACP `session/new` 的额外
 * 开销，以及并发下每个会话的耗时劣化，给 #37 的并发度上限一个有依据的取值。
 *
 * 它直连 `cursor-agent acp` 子进程，复刻 Cindy 的真实参数：
 *  - spawn：`cursor-agent acp`，detached（进程组），env 注入隔离
 *    `CURSOR_CONFIG_DIR`（内容对齐 maker-core cursor/isolatedConfig.ts 的
 *    writeIsolatedCliConfig：approvalMode=allowlist、sandbox.mode=disabled）。
 *  - initialize：protocolVersion=1、
 *    clientCapabilities={fs:{readTextFile:false,writeTextFile:false},
 *    _meta:{parameterizedModelPicker:true}}、clientInfo=cindy/Cindy/0.0.0
 *    （对齐 packages/maker-core/src/agents/cursor/index.ts 的 client.initialize）。
 *  - session/new：`{cwd, mcpServers}`；mcpServers 为空数组（基线）或本探针起的
 *    两座 http MCP server（对齐 apps/desktop/src/main/maker-host/cursor-acp-mcp.ts
 *    的 buildCursorAcpMcpServers：type=http、name=cindy_orca /
 *    orca_worker_bridge、url=http://127.0.0.1:<port>/mcp/<name>?session=<id>、
 *    headers=[{name:'Authorization',value:'Bearer <token>'}]）。
 *
 * 本探针不 prompt、不落任何仓库内文件，隔离 config dir 建在 mkdtemp 下并在结束
 * 时删除。需要 `cursor-agent` 已登录。
 *
 * 用法：
 *   node scripts/cursor-acp-mcp-overhead-probe.mjs                 # 全矩阵
 *   node scripts/cursor-acp-mcp-overhead-probe.mjs --only=serial   # 只跑串行档
 *   node scripts/cursor-acp-mcp-overhead-probe.mjs --rounds=5
 *   node scripts/cursor-acp-mcp-overhead-probe.mjs --scenario=mcp --concurrency=8
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { execSync } from 'node:child_process';
import http from 'node:http';
import process from 'node:process';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest,
} from '@modelcontextprotocol/sdk/types.js';

// ── args ───────────────────────────────────────────────────────────────────

const argv = new Map(
  process.argv.slice(2).map((raw) => {
    const [k, v = 'true'] = raw.replace(/^--/, '').split('=');
    return [k, v];
  }),
);
const ROUNDS = Number(argv.get('rounds') ?? 3);
const BINARY = argv.get('binary') ?? 'cursor-agent';
const WORK_DIR = argv.get('cwd') ?? process.cwd();
const SESSION_NEW_TIMEOUT_MS = Number(argv.get('timeout') ?? 120_000);

// ── 假 Cindy MCP bridge（对齐 codexHttpBridge 的对外形状） ─────────────────

/**
 * 工具面只需要「数量 + schema 体量」可比：cindy_orca 真实 16 个工具
 * （13 team + 3 只读诊断），orca_worker_bridge 3 个。描述长度取真实工具的量级。
 */
const ORCA_TOOL_NAMES = [
  'start_team', 'end_team', 'create_worker', 'create_workers', 'list_workers',
  'switch_focus', 'send_to_worker', 'list_worker_queue', 'update_queued_message',
  'cancel_queued_message', 'idle_worker', 'archive_worker', 'list_available_models',
  'get_workspace_info', 'worker_status', 'read_worker',
];
const WORKER_BRIDGE_TOOL_NAMES = ['send_to_lead', 'read_lead', 'lead_status'];

const LONG_DESCRIPTION = [
  '在当前 workflow 内批量创建 2-32 个 Orca worker session。',
  '用户一次要求创建多个 Worker 时必须使用本工具，不要并行或连续多次调用 create_worker。',
  '本工具按 workers 顺序创建并返回真实逐项终态；首次命中 WORKER_LIMIT_HARD_EXCEEDED 后立即停止，剩余项标记 skipped，不再调用 host。',
  '结果包含 request_count / attempted_count / success_count / failure_count / skipped_count / not_created_count、hard limit 快照、确定生成的 user_report，以及每个 label 对应的 worker/session 或失败原因。success/failure/skipped 是互斥分区。',
].join('\n');

function toolDefs(names) {
  return names.map((name) => ({
    name,
    description: `${name} —— ${LONG_DESCRIPTION}`,
    inputSchema: {
      type: 'object',
      properties: {
        worker_id: { type: 'string', description: '目标 worker 的 worker_id 或 session_id 任一' },
        message: { type: 'string', description: '要投递给 worker 的消息正文' },
      },
      additionalProperties: false,
    },
  }));
}

function createFakeMcpServer(serverName, tools) {
  const server = new Server(
    { name: serverName, version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async () => ({
    content: [{ type: 'text', text: '{"ok":true}' }],
  }));
  return server;
}

/**
 * 起一座 http bridge：`/mcp/<serverName>`，bearer token 鉴权，只接 127.0.0.1。
 * 形状与 apps/desktop 的 codexHttpBridge 对齐（streamable http + per-transport
 * session id），probe 侧不做 session ctx 路由，只统计每个 server 收到的请求。
 */
async function startFakeBridge() {
  const token = randomBytes(24).toString('hex');
  /** serverName -> { [jsonrpc method]: count }；用来验证注入的 server 真被消费。 */
  const stats = new Map();
  const factories = {
    cindy_orca: () => createFakeMcpServer('cindy_orca', toolDefs(ORCA_TOOL_NAMES)),
    orca_worker_bridge: () => createFakeMcpServer('orca_worker_bridge', toolDefs(WORKER_BRIDGE_TOOL_NAMES)),
  };
  for (const name of Object.keys(factories)) stats.set(name, {});
  /** mcp-session-id -> { transport } per server. */
  const transports = new Map();

  const readBody = (req) => new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve(undefined);
      try { resolve(JSON.parse(raw)); } catch (err) { reject(err); }
    });
    req.on('error', reject);
  });

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const serverName = url.pathname.startsWith('/mcp/') ? url.pathname.slice('/mcp/'.length) : null;
    const auth = req.headers['authorization'];
    if (auth !== `Bearer ${token}`) {
      res.statusCode = 401;
      res.end();
      return;
    }
    if (!serverName || !factories[serverName]) {
      res.statusCode = 404;
      res.end();
      return;
    }
    let body;
    try {
      body = req.method === 'POST' ? await readBody(req) : undefined;
    } catch {
      res.statusCode = 400;
      res.end();
      return;
    }
    const counters = stats.get(serverName);
    const methods = Array.isArray(body) ? body.map((m) => m?.method) : [body?.method];
    for (const method of methods) {
      const key = method ?? `${req.method} (no jsonrpc method)`;
      counters[key] = (counters[key] ?? 0) + 1;
    }

    const sessionHeader = req.headers['mcp-session-id'];
    const existing = typeof sessionHeader === 'string' ? transports.get(sessionHeader) : undefined;
    if (existing) {
      await existing.transport.handleRequest(req, res, body);
      return;
    }
    if (req.method !== 'POST' || !isInitializeRequest(body)) {
      res.statusCode = 400;
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request: no valid session' },
        id: null,
      }));
      return;
    }
    const mcpServer = factories[serverName]();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => transports.set(id, { transport, mcpServer }),
    });
    transport.onclose = () => {
      if (transport.sessionId) transports.delete(transport.sessionId);
    };
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, body);
  });

  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = httpServer.address();
  return {
    port,
    token,
    stats,
    snapshotStats: () => Object.fromEntries([...stats].map(([k, v]) => [k, { ...v }])),
    async close() {
      for (const { transport } of transports.values()) {
        await transport.close().catch(() => undefined);
      }
      await new Promise((resolve) => httpServer.close(resolve));
    },
  };
}

function buildAcpMcpServers({ port, token, sessionId }) {
  return ['cindy_orca', 'orca_worker_bridge'].map((name) => ({
    type: 'http',
    name,
    url: `http://127.0.0.1:${port}/mcp/${name}?session=${encodeURIComponent(sessionId)}`,
    headers: [{ name: 'Authorization', value: `Bearer ${token}` }],
  }));
}

// ── 隔离 CURSOR_CONFIG_DIR（对齐 isolatedConfig.ts） ───────────────────────

const probeRoot = mkdtempSync(join(tmpdir(), 'cursor-acp-probe-'));

function createIsolatedConfigDir(key) {
  const dir = join(probeRoot, key);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'cli-config.json'),
    `${JSON.stringify({
      version: 1,
      permissions: { allow: [], deny: [] },
      approvalMode: 'allowlist',
      sandbox: { mode: 'disabled', networkAccess: 'user_config_with_defaults' },
      editor: { vimMode: false },
      network: { useHttp1ForAgent: false },
    }, null, 2)}\n`,
  );
  return dir;
}

// ── 最小 ACP 客户端（NDJSON JSON-RPC over stdio） ──────────────────────────

function startAcp({ configDir, onStderr }) {
  const child = spawn(BINARY, ['acp'], {
    cwd: WORK_DIR,
    env: { ...process.env, CURSOR_CONFIG_DIR: configDir },
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    detached: true,
  });
  const pending = new Map();
  let nextId = 1;
  let closedReason = null;

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => onStderr?.(String(chunk)));

  const write = (payload) => new Promise((resolve, reject) => {
    child.stdin.write(`${JSON.stringify(payload)}\n`, 'utf8', (err) => (err ? reject(err) : resolve()));
  });

  rl.on('line', (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id !== undefined && msg.method === undefined) {
      const entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(`${msg.error.code} ${msg.error.message}`));
      else entry.resolve(msg.result);
      return;
    }
    // agent → client 请求：探针不参与任何权限/文件交互，一律拒绝，避免挂住。
    if (msg.id !== undefined && msg.method) {
      void write({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: `probe does not implement ${msg.method}` },
      }).catch(() => undefined);
    }
  });

  const fail = (reason) => {
    closedReason = reason;
    for (const [, entry] of pending) entry.reject(new Error(reason));
    pending.clear();
  };
  child.on('error', (err) => fail(`child error: ${err.message}`));
  child.on('exit', (code, signal) => fail(`child exited code=${code} signal=${signal}`));

  return {
    pid: child.pid,
    request(method, params, timeoutMs = SESSION_NEW_TIMEOUT_MS) {
      if (closedReason) return Promise.reject(new Error(closedReason));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        pending.set(id, {
          resolve: (v) => { clearTimeout(timer); resolve(v); },
          reject: (e) => { clearTimeout(timer); reject(e); },
        });
        write({ jsonrpc: '2.0', id, method, params }).catch((err) => {
          clearTimeout(timer);
          pending.delete(id);
          reject(err);
        });
      });
    },
    async close() {
      try { child.stdin.end(); } catch { /* noop */ }
      try { if (child.pid) process.kill(-child.pid, 'SIGTERM'); } catch { /* noop */ }
      await new Promise((resolve) => setTimeout(resolve, 200));
      try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* noop */ }
      try { rl.close(); } catch { /* noop */ }
    },
  };
}

// ── 单次测量 ───────────────────────────────────────────────────────────────

/**
 * 起一个 ACP 会话并测两段耗时：spawn+initialize、session/new。
 * withMcp=true 时 session/new 带 Cindy 真实注入的两座 http MCP server。
 */
async function measureSession({ label, withMcp, bridge }) {
  const sessionId = `probe-${label}-${randomUUID()}`;
  const configDir = createIsolatedConfigDir(sessionId);
  const stderr = [];
  const acp = startAcp({ configDir, onStderr: (s) => stderr.push(s) });
  const t0 = performance.now();
  try {
    await acp.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        _meta: { parameterizedModelPicker: true },
      },
      clientInfo: { name: 'cindy', title: 'Cindy', version: '0.0.0' },
    }, 60_000);
    const t1 = performance.now();
    const mcpServers = withMcp
      ? buildAcpMcpServers({ port: bridge.port, token: bridge.token, sessionId })
      : [];
    const created = await acp.request('session/new', { cwd: WORK_DIR, mcpServers });
    const t2 = performance.now();
    if (!created?.sessionId) throw new Error('session/new returned no sessionId');
    return {
      ok: true,
      spawnInitMs: Math.round(t1 - t0),
      sessionNewMs: Math.round(t2 - t1),
      totalMs: Math.round(t2 - t0),
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      stderr: stderr.join('').slice(-800),
    };
  } finally {
    await acp.close();
  }
}

function stats(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    n: sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: Math.round(sum / sorted.length),
    median: sorted[Math.floor(sorted.length / 2)],
  };
}

function fmt(ms) {
  return `${(ms / 1000).toFixed(2)}s`;
}

function report(title, results, wallMs, peakRssMb) {
  const ok = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  const line = [
    `▸ ${title}`,
    `  sessions=${results.length} ok=${ok.length} failed=${failed.length}`,
  ];
  const init = stats(ok.map((r) => r.spawnInitMs));
  const sessionNew = stats(ok.map((r) => r.sessionNewMs));
  const total = stats(ok.map((r) => r.totalMs));
  if (init) line.push(`  spawn+initialize: ${ok.map((r) => fmt(r.spawnInitMs)).join(' / ')}  (median ${fmt(init.median)})`);
  if (sessionNew) line.push(`  session/new:      ${ok.map((r) => fmt(r.sessionNewMs)).join(' / ')}  (median ${fmt(sessionNew.median)}, mean ${fmt(sessionNew.mean)}, min ${fmt(sessionNew.min)}, max ${fmt(sessionNew.max)})`);
  if (total) line.push(`  per-session total:${ok.map((r) => fmt(r.totalMs)).join(' / ')}  (median ${fmt(total.median)})`);
  if (wallMs !== undefined) line.push(`  wall clock:       ${fmt(wallMs)}`);
  if (peakRssMb !== undefined) line.push(`  peak cursor-agent RSS (all procs): ${peakRssMb}MB`);
  for (const f of failed) line.push(`  FAILED: ${f.error}${f.stderr ? `\n    stderr: ${f.stderr}` : ''}`);
  console.log(line.join('\n'));
  return { sessionNew, total, wallMs, ok: ok.length, failed: failed.length };
}

async function runSerial({ withMcp, rounds, bridge, title }) {
  const results = [];
  const t0 = performance.now();
  for (let i = 0; i < rounds; i += 1) {
    results.push(await measureSession({ label: `serial-${withMcp ? 'mcp' : 'empty'}-${i}`, withMcp, bridge }));
  }
  return report(title, results, performance.now() - t0);
}

async function runConcurrent({ withMcp, concurrency, bridge, title }) {
  const rss = startRssSampler();
  const t0 = performance.now();
  const results = await Promise.all(
    Array.from({ length: concurrency }, (_, i) =>
      measureSession({ label: `conc${concurrency}-${withMcp ? 'mcp' : 'empty'}-${i}`, withMcp, bridge })),
  );
  const wallMs = performance.now() - t0;
  const peakRssMb = rss.stop();
  return { ...report(title, results, wallMs, peakRssMb), peakRssMb };
}

/**
 * 采样机器上所有 cursor-agent 进程(含 fork 出的 worker-server)的 RSS 之和峰值。
 * 并发度上限不只看耗时，也要看单机内存代价。
 */
function startRssSampler() {
  let peakKb = 0;
  const timer = setInterval(() => {
    try {
      const out = execSync("ps -Ao rss=,command= | grep -i '[c]ursor-agent' || true", { encoding: 'utf8' });
      const sum = out
        .split('\n')
        .map((line) => Number.parseInt(line.trim().split(/\s+/)[0] ?? '', 10))
        .filter((n) => Number.isFinite(n))
        .reduce((a, b) => a + b, 0);
      if (sum > peakKb) peakKb = sum;
    } catch { /* 采样失败不影响测量 */ }
  }, 700);
  timer.unref?.();
  return {
    stop() {
      clearInterval(timer);
      return Math.round(peakKb / 1024);
    },
  };
}

async function runSweep({ levels, repeats, bridge, withMcp }) {
  const rows = [];
  for (const concurrency of levels) {
    for (let r = 0; r < repeats; r += 1) {
      const res = await runConcurrent({
        withMcp,
        concurrency,
        bridge,
        title: `sweep c=${concurrency} run ${r + 1}/${repeats} (${withMcp ? 'with MCP' : 'empty'})`,
      });
      rows.push({ concurrency, run: r + 1, ...res });
      console.log('');
    }
  }
  console.log('=== sweep table ===');
  console.log('conc  run  wall      per-session(median)  throughput(sessions/min)  peakRSS');
  for (const row of rows) {
    const perSession = row.total ? fmt(row.total.median) : 'n/a';
    const throughput = row.wallMs ? ((row.concurrency / row.wallMs) * 60_000).toFixed(1) : 'n/a';
    console.log(
      `${String(row.concurrency).padEnd(5)} ${String(row.run).padEnd(4)} ${fmt(row.wallMs).padEnd(9)} `
      + `${perSession.padEnd(20)} ${String(throughput).padEnd(25)} ${row.peakRssMb}MB`
      + (row.failed ? `  failed=${row.failed}` : ''),
    );
  }
  return rows;
}

// ── main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('cursor-agent ACP session/new overhead probe (issue #35)');
  console.log(`binary=${BINARY} cwd=${WORK_DIR} rounds=${ROUNDS} node=${process.version}`);
  const bridge = await startFakeBridge();
  console.log(`fake MCP bridge on 127.0.0.1:${bridge.port} (cindy_orca: ${ORCA_TOOL_NAMES.length} tools, orca_worker_bridge: ${WORKER_BRIDGE_TOOL_NAMES.length} tools)\n`);

  const only = argv.get('only');
  const scenario = argv.get('scenario');
  const sweep = argv.get('sweep');
  const summary = {};
  try {
    if (sweep) {
      await runSweep({
        levels: sweep.split(',').map((n) => Number(n.trim())).filter((n) => n > 0),
        repeats: Number(argv.get('repeats') ?? 2),
        bridge,
        withMcp: argv.get('empty') !== 'true',
      });
    } else if (scenario) {
      const concurrency = Number(argv.get('concurrency') ?? 1);
      const withMcp = scenario === 'mcp';
      summary.custom = concurrency > 1
        ? await runConcurrent({ withMcp, concurrency, bridge, title: `${scenario} × ${concurrency} concurrent` })
        : await runSerial({ withMcp, rounds: ROUNDS, bridge, title: `${scenario} serial × ${ROUNDS}` });
    } else {
      if (!only || only === 'serial') {
        summary.emptySerial = await runSerial({ withMcp: false, rounds: ROUNDS, bridge, title: `A. baseline: empty mcpServers, serial × ${ROUNDS}` });
        console.log(`   bridge requests so far: ${JSON.stringify(bridge.snapshotStats())}\n`);
        summary.mcpSerial = await runSerial({ withMcp: true, rounds: ROUNDS, bridge, title: `B. with Cindy MCP servers, serial × ${ROUNDS}` });
        console.log(`   bridge requests so far: ${JSON.stringify(bridge.snapshotStats())}\n`);
      }
      if (!only || only === 'concurrent') {
        summary.mcpConc4 = await runConcurrent({ withMcp: true, concurrency: 4, bridge, title: 'C. with MCP servers, 4 concurrent' });
        console.log(`   bridge requests so far: ${JSON.stringify(bridge.snapshotStats())}\n`);
        summary.mcpConc8 = await runConcurrent({ withMcp: true, concurrency: 8, bridge, title: 'D. with MCP servers, 8 concurrent' });
        console.log(`   bridge requests so far: ${JSON.stringify(bridge.snapshotStats())}\n`);
        summary.emptyConc4 = await runConcurrent({ withMcp: false, concurrency: 4, bridge, title: 'E. control: empty mcpServers, 4 concurrent' });
      }
    }
  } finally {
    console.log(`\nfinal bridge request counts: ${JSON.stringify(bridge.snapshotStats())}`);
    await bridge.close();
    rmSync(probeRoot, { recursive: true, force: true });
  }
  console.log('\n=== summary (session/new median) ===');
  for (const [key, value] of Object.entries(summary)) {
    if (!value?.sessionNew) continue;
    console.log(`${key.padEnd(12)} median=${fmt(value.sessionNew.median)} mean=${fmt(value.sessionNew.mean)} n=${value.sessionNew.n} wall=${value.wallMs ? fmt(value.wallMs) : 'n/a'} failed=${value.failed}`);
  }
}

main().catch((err) => {
  console.error(err);
  rmSync(probeRoot, { recursive: true, force: true });
  process.exit(1);
});
