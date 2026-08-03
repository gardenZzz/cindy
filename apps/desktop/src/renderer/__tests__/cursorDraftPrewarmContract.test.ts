import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const routeSource = readFileSync(
  fileURLToPath(new URL('../features/cc-agent/NewMakerDraftRoute.tsx', import.meta.url)),
  'utf8',
);
const gateSource = readFileSync(
  fileURLToPath(new URL('../hooks/useVendorAuthGate.ts', import.meta.url)),
  'utf8',
);
const chatStoreSource = readFileSync(
  fileURLToPath(new URL('../lib/makerChatStore.ts', import.meta.url)),
  'utf8',
);
const titleSource = readFileSync(
  fileURLToPath(new URL('../../main/maker-ipc/title.ts', import.meta.url)),
  'utf8',
);

describe('Cursor New Maker 预热契约', () => {
  it('选择 Cursor 后预热 ACP session/new，发送时 claim 同一 business id', () => {
    expect(routeSource).toContain('.prewarmSession({');
    expect(routeSource).toContain('claimPrewarmSession(prewarm.sessionId)');
    expect(routeSource).toContain('cancelPrewarmSession(sessionId)');
  });

  it('发送门禁只读缓存，不在 Enter 热路径 spawn status', () => {
    expect(gateSource).toContain('peekCursorAvailability()');
    expect(gateSource).toContain('peekCursorAuthState()');
    expect(gateSource).not.toContain("maker.auth.getState('cursor')");
    expect(gateSource).not.toContain('await getCursorAvailability()');
  });

  it('Cursor 自动标题在 enqueue 接受后再启动', () => {
    // 合并后走 operation.api.input.enqueue(...),不是旧的 .input.enqueue 直调。
    const enqueue = chatStoreSource.indexOf('.enqueue(sessionId, queued');
    const cursorGuard = chatStoreSource.indexOf(
      "if (current.agentKind !== 'cursor') runAutoName();",
    );
    const runAfterEnqueue = chatStoreSource.indexOf('runAutoName();', enqueue);
    expect(enqueue).toBeGreaterThan(-1);
    expect(cursorGuard).toBeGreaterThan(-1);
    expect(runAfterEnqueue).toBeGreaterThan(enqueue);
  });

  it('cursor-agent -p 标题等 ACP session/new 就绪后再起', () => {
    expect(titleSource).toContain('waitForSessionBootstrap(sessionId)');
    expect(titleSource).toContain('await maker.waitForSessionBootstrap(sessionId)');
  });
});
