/**
 * Opt-in Cursor ACP seam + lifecycle integration tests.
 *
 * Spawns a real `cursor-agent acp` subprocess.
 * Default: skipped (billed). Manual:
 *   CINDY_CURSOR_ACP_E2E=1 pnpm --filter @cindy/maker-core run test -- src/agents/cursor/cursorAcp.e2e.test.ts
 *
 * After the run, verify no orphan ACP processes:
 *   pgrep -lf "cursor-agent.* acp$"
 */

import { afterAll, describe, expect, it } from 'vitest';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { accessSync, constants, existsSync, mkdtempSync } from 'node:fs';
import { execSync } from 'node:child_process';

import { createConsoleLogger } from '../../interfaces/logger.js';
import { CursorAgent } from './index.js';
import type { AuthAdapter } from '../../interfaces/auth-adapter.js';
import type { AgentEvent } from '../../types/events.js';

const ENABLED = process.env.CINDY_CURSOR_ACP_E2E === '1';

function resolveCursorBinary(): string | null {
  const candidates = [
    path.join(homedir(), '.local', 'bin', 'cursor-agent'),
    'cursor-agent',
  ];
  for (const c of candidates) {
    try {
      if (c === 'cursor-agent') {
        execSync('command -v cursor-agent', { stdio: 'ignore' });
        return c;
      }
      if (existsSync(c)) {
        accessSync(c, constants.X_OK);
        return c;
      }
    } catch {
      /* try next */
    }
  }
  return null;
}

function createAuthStub(): AuthAdapter {
  return {
    getState: async () => ({ authenticated: true }),
    triggerLogin: async () => ({ authenticated: true }),
    logout: async () => undefined,
    getAuthEnv: async () => ({}),
  };
}

/** Only count ACP session processes — ignore IDE `cursor-agent -p` jobs. */
function countCursorAcpProcesses(): number {
  try {
    const out = execSync("ps -ax -o pid=,command= | grep -E '[c]ursor-agent' || true", {
      encoding: 'utf8',
    });
    return out
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && /\bacp\b/.test(l)).length;
  } catch {
    return -1;
  }
}

function listCursorAcpProcesses(): string {
  try {
    return execSync('pgrep -lf "cursor-agent.* acp$" || true', { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function createAgent(): CursorAgent {
  return new CursorAgent({
    auth: createAuthStub(),
    runtimeConfig: {
      userDataPath: mkdtempSync(path.join(tmpdir(), 'cindy-cursor-e2e-')),
    },
    binaryPath: resolveCursorBinary()!,
    logger: createConsoleLogger('cursor-acp-e2e'),
  });
}

describe.skipIf(!ENABLED)('Cursor ACP e2e (opt-in, billed)', () => {
  const binaryPath = resolveCursorBinary();
  const pidsBefore = countCursorAcpProcesses();
  const closers: Array<() => Promise<void>> = [];

  afterAll(async () => {
    for (const close of closers.splice(0)) {
      try {
        await close();
      } catch {
        /* best-effort */
      }
    }
    await new Promise((r) => setTimeout(r, 1500));
    const pidsAfter = countCursorAcpProcesses();
    if (pidsBefore >= 0 && pidsAfter > pidsBefore) {
      throw new Error(
        `orphan cursor-agent acp processes detected: before=${pidsBefore} after=${pidsAfter}\n${listCursorAcpProcesses()}`,
      );
    }
  });

  it('streams assistant text for a short prompt and closes cleanly', async () => {
    expect(binaryPath, 'cursor-agent binary not found').toBeTruthy();

    const agent = createAgent();
    const handle = await agent.startSession({
      sessionId: `cursor-e2e-${Date.now()}`,
      model: 'auto',
      workingDir: process.cwd(),
    });
    closers.push(() => handle.close());

    const textChunks: string[] = [];
    let finalText = '';
    let sawRunning = false;
    let sawStopped = false;
    let sawDone = false;
    let turnError: string | null = null;

    const consume = (async () => {
      for await (const ev of handle.events()) {
        const event = ev as AgentEvent;
        if (event.type === 'text') {
          const data = event.data as { text?: string; isFinal?: boolean };
          if (typeof data.text !== 'string' || data.text.length === 0) continue;
          if (data.isFinal) finalText = data.text;
          else textChunks.push(data.text);
        } else if (event.type === 'status') {
          const data = event.data as { isRunning?: boolean };
          if (data.isRunning === true) sawRunning = true;
          if (data.isRunning === false) sawStopped = true;
        } else if (event.type === 'done') {
          sawDone = true;
        } else if (event.type === 'error') {
          turnError = String((event.data as { message?: string })?.message ?? event.data);
        }
      }
    })();

    await handle.send({
      type: 'user',
      content: 'Reply with exactly one word: pong',
    });

    await handle.close();
    closers.length = 0;
    await consume;

    expect(turnError, `unexpected turn error: ${turnError}`).toBeNull();
    expect(sawRunning).toBe(true);
    expect(sawStopped).toBe(true);
    expect(sawDone).toBe(true);
    const streamed = textChunks.join('');
    const joined = finalText || streamed;
    expect(joined.length).toBeGreaterThan(0);
    expect(joined.toLowerCase()).toContain('pong');

    console.log('[cursor-acp-e2e] streamed deltas:', JSON.stringify(streamed));
    console.log('[cursor-acp-e2e] final text:', JSON.stringify(finalText));
  }, 180_000);

  it('resume after kill continues; cancel aborts; dispose leaves no orphans', async () => {
    expect(binaryPath, 'cursor-agent binary not found').toBeTruthy();
    const before = countCursorAcpProcesses();
    const bizId = `cursor-e2e-resume-${Date.now()}`;

    const agent1 = createAgent();
    const handle1 = await agent1.startSession({
      sessionId: bizId,
      model: 'auto',
      workingDir: '/tmp',
    });
    closers.push(() => handle1.close());
    const sdkSessionId = handle1.id;
    expect(sdkSessionId.length).toBeGreaterThan(8);

    const events1: AgentEvent[] = [];
    const consume1 = (async () => {
      for await (const ev of handle1.events()) events1.push(ev);
    })();

    await handle1.send({
      type: 'user',
      content: 'Reply with exactly one word: alpha',
    });

    // Hard-kill the ACP child to simulate crash (leave sdk session id intact).
    const pid = (handle1 as { _acpPid?: number | null })._acpPid;
    expect(typeof pid).toBe('number');
    try {
      process.kill(pid!, 'SIGKILL');
    } catch {
      /* already dead */
    }
    await new Promise((r) => setTimeout(r, 500));
    try {
      await handle1.close();
    } catch {
      /* transport already dead */
    }
    closers.length = 0;
    await consume1;

    // Resume on a fresh process — same Cindy business sessionId → same CURSOR_CONFIG_DIR.
    const agent2 = createAgent();
    const handle2 = await agent2.startSession({
      sessionId: bizId,
      model: 'auto',
      workingDir: '/tmp',
      resumeSessionId: sdkSessionId,
    });
    closers.push(() => handle2.close());
    expect(handle2.id).toBe(sdkSessionId);

    const events2: AgentEvent[] = [];
    let sawReplayText = false;
    const consume2 = (async () => {
      for await (const ev of handle2.events()) {
        events2.push(ev);
        if (ev.type === 'text') {
          const t = String((ev.data as { text?: string }).text ?? '');
          if (t.toLowerCase().includes('alpha')) sawReplayText = true;
        }
      }
    })();

    // History must be skipped — Cindy renders from its own store.
    await new Promise((r) => setTimeout(r, 200));
    expect(sawReplayText).toBe(false);

    const send2 = handle2.send({
      type: 'user',
      content: 'Reply with exactly one word: beta',
    });

    // Mid-turn cancel: UI must return to idle promptly.
    await new Promise((r) => setTimeout(r, 400));
    const cancelStarted = Date.now();
    await handle2.abort();
    const cancelElapsed = Date.now() - cancelStarted;

    const idleDeadline = Date.now() + 5000;
    let sawIdle = false;
    while (Date.now() < idleDeadline) {
      sawIdle = events2.some(
        (e) =>
          e.type === 'status' &&
          (e.data as { isRunning?: boolean }).isRunning === false,
      );
      if (sawIdle) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(sawIdle).toBe(true);
    expect(cancelElapsed).toBeLessThan(3000);

    try {
      await send2;
    } catch {
      /* abort may reject hanging prompt via close path */
    }

    await handle2.close();
    closers.length = 0;
    await agent2.dispose();
    await consume2;

    await new Promise((r) => setTimeout(r, 1500));
    const after = countCursorAcpProcesses();
    console.log('[cursor-acp-e2e-lifecycle] acp pids before=', before, 'after=', after);
    console.log('[cursor-acp-e2e-lifecycle] pgrep:', listCursorAcpProcesses() || '(none)');
    expect(after).toBeLessThanOrEqual(before);
  }, 240_000);
});
