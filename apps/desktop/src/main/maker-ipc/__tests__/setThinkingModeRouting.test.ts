/**
 * set-thinking-mode：产品语义为「有 thinking 则强制开」。
 * live push 不得把 false 下发到 Cursor runtime。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const registerSource = readFileSync(resolve(__dirname, '..', 'register.ts'), 'utf8');

function extractSetThinkingModeHandler(source: string): string {
  const start = source.indexOf('MAKER_INVOKE.SET_THINKING_MODE');
  expect(start).toBeGreaterThanOrEqual(0);
  const end = source.indexOf('MAKER_INVOKE.MODEL_VISIBILITY_SYNC', start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('maker:set-thinking-mode live push routing', () => {
  it('never live-pushes thinking=false to cursor', () => {
    const handler = extractSetThinkingModeHandler(registerSource);
    // 不得无条件 await sess.setThinkingMode(enabled)
    expect(handler).not.toMatch(/await sess\.setThinkingMode\(enabled\)\s*;/);
    // false 路径必须 early return / no-op，或只在 enabled===true 时 push
    const forcesTrueOnly =
      /if\s*\(\s*!enabled\s*\)/.test(handler) ||
      /if\s*\(\s*enabled\s*\)/.test(handler) ||
      /setThinkingMode\(\s*true\s*\)/.test(handler);
    expect(forcesTrueOnly).toBe(true);
  });
});
