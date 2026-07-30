/**
 * set-fast-mode live push 路由：Cursor 必须下发到 runtime；claude-code 保持 main 原状 no-op。
 *
 * 现象：renderer 已写 sessions.fast_mode + 发 maker:set-fast-mode，但 main 只对
 * codex 调 sess.setFastMode，Cursor 的 ACP session/set_config_option(fast) 永不触发。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const registerSource = readFileSync(resolve(__dirname, '..', 'register.ts'), 'utf8');

/** 只取 SET_FAST_MODE handler 片段，避免被文件其它 agentKind 分支误伤。 */
function extractSetFastModeHandler(source: string): string {
  const start = source.indexOf('MAKER_INVOKE.SET_FAST_MODE');
  expect(start).toBeGreaterThanOrEqual(0);
  const end = source.indexOf('MAKER_INVOKE.SET_THINKING_MODE', start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('maker:set-fast-mode live push routing', () => {
  it('allows codex and cursor — claude-code stays no-op like main', () => {
    const handler = extractSetFastModeHandler(registerSource);
    // 旧门禁：if (sess.agentKind !== 'codex') return;
    expect(handler).not.toMatch(
      /if \(sess\.agentKind !== 'codex'\) \{\s*log\.debug\('set-fast-mode: agent does not implement fast mode/,
    );
    expect(handler).toContain("sess.agentKind !== 'cursor'");
    // live push 条件必须是 codex|cursor；不得扩成三元 claude-code 放行
    expect(handler).toMatch(
      /if \(sess\.agentKind !== 'codex' && sess\.agentKind !== 'cursor'\)/,
    );
    expect(handler).not.toMatch(
      /if \([\s\S]*agentKind !== 'claude-code'[\s\S]*\) \{\s*log\.debug\('set-fast-mode: agent does not implement fast mode/,
    );
    expect(handler).toContain('await sess.setFastMode(enabled)');
  });
});
