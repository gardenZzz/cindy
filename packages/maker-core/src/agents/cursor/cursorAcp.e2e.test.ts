/**
 * Opt-in Cursor ACP seam integration test.
 *
 * Spawns a real `cursor-agent acp` subprocess, creates a session, sends a short
 * prompt, and asserts streamed assistant text deltas before a clean close.
 *
 * This incurs a real billed model call. Default: skipped.
 *
 * Manual run:
 *   CINDY_CURSOR_ACP_E2E=1 pnpm --filter @cindy/maker-core run test -- src/agents/cursor/cursorAcp.e2e.test.ts
 *
 * Requires: cursor-agent on PATH (or ~/.local/bin), already logged in (`agent login`).
 * After the run, verify no orphan ACP processes:
 *   `ps -ax -o pid=,command= | grep -E '[c]ursor-agent' | grep -E '\\bacp\\b'`
 */

import { afterAll, describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import path from 'node:path';
import { accessSync, constants, existsSync } from 'node:fs';
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

describe.skipIf(!ENABLED)('Cursor ACP e2e (opt-in, billed)', () => {
  const binaryPath = resolveCursorBinary();
  const pidsBefore = countCursorAcpProcesses();
  let handleClose: (() => Promise<void>) | null = null;

  afterAll(async () => {
    if (handleClose) {
      try {
        await handleClose();
      } catch {
        /* best-effort */
      }
    }
    // Give the process a moment to exit after close.
    await new Promise((r) => setTimeout(r, 1500));
    const pidsAfter = countCursorAcpProcesses();
    if (pidsBefore >= 0 && pidsAfter > pidsBefore) {
      throw new Error(
        `orphan cursor-agent acp processes detected: before=${pidsBefore} after=${pidsAfter}`,
      );
    }
  });

  it('streams assistant text for a short prompt and closes cleanly', async () => {
    expect(binaryPath, 'cursor-agent binary not found').toBeTruthy();

    const agent = new CursorAgent({
      auth: createAuthStub(),
      runtimeConfig: {},
      binaryPath: binaryPath!,
      logger: createConsoleLogger('cursor-acp-e2e'),
    });

    const cwd = process.cwd();
    const handle = await agent.startSession({
      sessionId: `cursor-e2e-${Date.now()}`,
      model: 'auto',
      workingDir: cwd,
    });
    handleClose = () => handle.close();

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
    handleClose = null;
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
    console.log('[cursor-acp-e2e] delta chunk count:', textChunks.length);
  }, 180_000);
});
