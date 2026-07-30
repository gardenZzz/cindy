/**
 * ModelSelector：Cursor Thinking 去掉可选 UI（spec #14）。
 * 源码不变式：不再渲染 thinkingLabel / onThinkingModeChange 驱动的开关行。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const selectorSource = readFileSync(resolve(__dirname, '..', 'ModelSelector.tsx'), 'utf8');

describe('ModelSelector Thinking optional UI removed', () => {
  it('does not render Thinking toggle from thinkingLabel', () => {
    expect(selectorSource).not.toContain("t('newChat.modelSelector.thinkingLabel')");
    expect(selectorSource).not.toContain('editShowThinking');
    expect(selectorSource).not.toContain('thinkingEditable');
    expect(selectorSource).not.toContain('handleEditThinking');
  });
});
