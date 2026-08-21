import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// 非阻塞预热（claim-if-ready）契约测试（S3）。
//
// 背景：旧预热实现（736d392fc，已回退）在 IPC/发送路径 `await prewarm.ready`，
// 把 bootstrap 等待搬进发送热路径导致 UI 卡住（ADR 0003 回退根因）。本契约断言
// **发送热路径零 await 会话就绪**：claim 只查就绪标志、立即返回布尔，prewarm
// 在后台 fire-and-forget。这些断言是源码契约探针——专门钉住「发送阻塞」回归。
//
// 领域词汇（与 spec #74 / maker-core 池层一致）：预热 / claim / 就绪。

const routeSource = readFileSync(
  fileURLToPath(new URL('../features/cc-agent/NewMakerDraftRoute.tsx', import.meta.url)),
  'utf8',
);
const makerCoreSource = readFileSync(
  fileURLToPath(
    new URL('../../../../../packages/maker-core/src/maker.ts', import.meta.url),
  ),
  'utf8',
);

function sliceFunction(source: string, name: string): string {
  const start = source.indexOf(`async ${name}(`);
  const fallback = source.indexOf(`async ${name} `);
  const idx = start >= 0 ? start : fallback;
  if (idx < 0) throw new Error(`function ${name} not found`);
  const open = source.indexOf('{', idx);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(idx, i + 1);
    }
  }
  throw new Error(`function ${name} body not closed`);
}

describe('Cursor 非阻塞预热契约（claim-if-ready）', () => {
  it('发送热路径调 claim（而非 await 就绪），claim 未命中回退普通创建', () => {
    // 发送路径必须走 claim-if-ready：claim 返回布尔，命中复用、未命中回退。
    expect(routeSource).toContain('await claimCursorPrewarmSession()');
    // 回退必须是普通创建（新 draft id），而不是在 claim 上等就绪。
    expect(routeSource).toContain('makeDraftSessionId()');
  });

  it('maker-core claim 只查就绪标志、不 await bootstrap（非阻塞核心）', () => {
    const claim = sliceFunction(makerCoreSource, 'claimPrewarmedSession');
    expect(claim).toContain('if (!entry.ready) return false;');
    // 本方法不 await handle / bootstrapReady：claim 立即返回布尔。
    expect(claim).not.toContain('await entry.handle');
    expect(claim).not.toContain('await handle.bootstrapReady');
  });

  it('maker-core prewarm 对 bootstrap 是 fire-and-forget，不 await 就绪', () => {
    const prewarm = sliceFunction(makerCoreSource, 'prewarmSession');
    // bootstrap 就绪经后台 watcher 置 ready 标记，调用方立即返回。
    expect(prewarm).toContain('entry.ready = true');
    // prewarm 方法体里没有 await bootstrapReady（无 `await entry.handle`）。
    expect(prewarm).not.toContain('await entry.handle');
  });

  it('renderer prewarm effect 用 fire-and-forget 启动，不把 bootstrap 等回发送路径', () => {
    // 预热 effect 内部启动后台会话；调用方（prewarmSession IPC）立即 resolve。
    expect(routeSource).toContain('await window.electronAPI.maker.prewarmSession({');
    // 发送路径里绝无 await 就绪的调用形态（旧版回归点）：没有 `.ready` 字段被 await。
    expect(routeSource).not.toContain('await prewarm.ready');
    expect(routeSource).not.toContain('await cursorPrewarmRef.current.ready');
  });

  it('claim 只在就绪时接管；未就绪/无预热时发送路径不报错、走普通流程', () => {
    // claimCursorPrewarmSession 返回 { sessionId, prewarmed }，不抛错：
    // 未就绪时回收预热句柄并回退 makeDraftSessionId。
    expect(routeSource).toContain('prewarmed: false }');
    expect(routeSource).toContain('cancelPrewarmSession(prewarm.sessionId)');
  });
});
