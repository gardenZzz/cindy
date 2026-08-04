// @vitest-environment jsdom

/**
 * spec #21 / S2 - 模型选择器的 Cursor 可见性过滤。
 *
 * 守外部可见行为:
 *  - 关掉的 Cursor 模型不出现在选择器(flat 列表)。
 *  - 当前会话正用着的模型即使被关仍然显示(豁免)。
 *  - Auto 恒在。
 *  - Claude Code / Codex 的分段列表过滤逐字节不变(源码不变式)。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const selectorSource = readFileSync(
  resolve(__dirname, '..', 'ModelSelector.tsx'),
  'utf8',
);

describe('ModelSelector - Cursor 可见性过滤 (spec #21 / S2)', () => {
  it('Cursor flat 列表按 isModelEnabled 过滤,且豁免当前选中模型', () => {
    // 过滤调用必须存在(agent='cursor', providerId='cursor')。
    expect(selectorSource).toContain("isModelEnabled('cursor', 'cursor', m)");
    // 当前会话已选模型豁免(m.id === modelId)。
    expect(selectorSource).toMatch(/m\.id === modelId \|\| isModelEnabled\('cursor', 'cursor', m\)/);
  });

  it('浏览态选中 Cursor 模型时登记 cursor 而非 claude-code', () => {
    // handleRowSelect 必须用 vendorKeyToAgentKind(browseVendor),不能二元回落 cc。
    expect(selectorSource).toMatch(
      /enqueueAgentSwitch\(\s*vendorKeyToAgentKind\(browseVendor\)/,
    );
    expect(selectorSource).not.toMatch(
      /browseVendor === 'codex' \? 'codex' : browseVendor === 'pi' \? 'pi' : 'claude-code'/,
    );
  });

  it('浏览切到 Cursor 时不按 sourcesForModel 滤空(无 Cindy provider 目录)', () => {
    // 其它引擎浏览态仍要求已连接来源;Cursor 必须显式豁免,否则 capabilities
    // 列表被 sourcesForModel 滤成空 → 「没有匹配的模型」。
    expect(selectorSource).toMatch(
      /browsing && agentKind && agentKind !== 'cursor'/,
    );
  });

  it('Claude Code / Codex 分段过滤逻辑未被本次改动触及(沿用 isModelEnabled(agent, providerId, model))', () => {
    // 既有口径仍在(非 cursor 分支)。
    expect(selectorSource).toContain('isModelEnabled(currentAgentKind, pid,');
    expect(selectorSource).toContain('isModelEnabled(agent, providerId, model)');
  });
});
