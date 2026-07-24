import { describe, expect, it, vi } from 'vitest';

import {
  buildHandoffText,
  createAgentHandoffPendingRegistry,
  extractPlainText,
  prependHandoffToUserMessage,
  type HandoffSourceMessage,
} from '../agentHandoff';

function msg(role: string, content: unknown, createdAt = 0): HandoffSourceMessage {
  return { role, content, createdAt };
}

describe('extractPlainText', () => {
  it('透传纯文本', () => {
    expect(extractPlainText('你好')).toBe('你好');
  });

  it('解析 JSON 字符串形态的 {text} 与 SDK blocks', () => {
    expect(extractPlainText(JSON.stringify({ text: 'hi', images: [], files: [] }))).toBe('hi');
    expect(
      extractPlainText(JSON.stringify([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }])),
    ).toBe('a\nb');
  });

  it('对象形态取 text / message,未知形态回空', () => {
    expect(extractPlainText({ text: 't' })).toBe('t');
    expect(extractPlainText({ message: 'm' })).toBe('m');
    expect(extractPlainText(42)).toBe('');
    expect(extractPlainText(null)).toBe('');
  });

  it('DB user envelope uses semantic projection for quote and message chips', () => {
    const href = 'cindy://session/session-a?message=message-a';
    const text = `> <!-- cindy-composer-quote -->\n> selected\n\ninspect ${href}`;
    const content = {
      text,
      quotesEncoded: true,
      agentReferences: [{
        kind: 'message',
        start: text.indexOf(href),
        end: text.indexOf(href) + href.length,
        href,
        sessionId: 'session-a',
        messageClientId: 'message-a',
        text: 'Target message body',
      }],
    };

    const projected = extractPlainText(JSON.stringify(content));
    expect(projected).not.toContain('cindy-composer-quote');
    expect(projected).not.toContain(href);
    expect(projected).toContain('Target message body');
  });

  it('DB user envelope preserves a hand-written marker without quotesEncoded', () => {
    const text = '> <!-- cindy-composer-quote -->\n> hand written';
    expect(extractPlainText({ text, quotesEncoded: false })).toBe(text);
  });
});

describe('buildHandoffText', () => {
  const opts = { fromLabel: 'Claude Code', toLabel: 'Codex' };

  it('framing 包含续接指令与双引擎名,并以结束标记收尾', () => {
    const text = buildHandoffText([msg('user', '第一个问题'), msg('assistant', '第一个回答')], opts);
    expect(text).toContain('Claude Code');
    expect(text).toContain('Codex');
    expect(text).toContain('不要向用户提及本段交接说明');
    expect(text.trimEnd().endsWith('== 交接说明结束,以下是用户的新消息 ==')).toBe(true);
  });

  it('最近轮次逐字保留,更早轮次进单行提要', () => {
    const messages: HandoffSourceMessage[] = [];
    for (let i = 0; i < 8; i++) {
      messages.push(msg('user', `问题${i}`));
      messages.push(msg('assistant', `回答${i}`));
    }
    const text = buildHandoffText(messages, opts);
    // 最近 4 轮(4..7)逐字
    expect(text).toContain('[用户]\n问题7');
    expect(text).toContain('[助手]\n回答7');
    expect(text).toContain('[用户]\n问题4');
    // 更早轮(0..3)在提要区
    expect(text).toContain('- 用户: 问题0');
    expect(text).toContain('回应: 回答3');
    expect(text).not.toContain('[用户]\n问题0');
  });

  it('工具调用渲染为 name + input 摘要,tool_result/thinking 不进正文', () => {
    const text = buildHandoffText(
      [
        msg('user', '改一下代码'),
        msg('tool_use', { toolUseId: 't1', toolName: 'Read', input: { file_path: '/a.ts' } }),
        msg('tool_result', { anything: 'x'.repeat(500) }),
        msg('thinking', { kind: 'thinking', text: '内心戏' }),
        msg('assistant', '改好了'),
      ],
      opts,
    );
    expect(text).toContain('[工具] Read: {"file_path":"/a.ts"}');
    expect(text).not.toContain('内心戏');
    expect(text).not.toContain('x'.repeat(200));
  });

  it('合成指令行([UI_ACTION_TRIGGER])不进交接', () => {
    const text = buildHandoffText(
      [msg('user', '正常消息'), msg('user', '[UI_ACTION_TRIGGER] resume'), msg('assistant', '好')],
      opts,
    );
    expect(text).not.toContain('UI_ACTION_TRIGGER');
    expect(text).toContain('正常消息');
  });

  it('handoff history never exposes product quote markers or private deep-link-only semantics', () => {
    const href = 'cindy://session/session-a?message=message-a';
    const text = `> <!-- cindy-composer-quote -->\n> selected\n\ninspect ${href}`;
    const handoff = buildHandoffText([
      msg('user', {
        text,
        quotesEncoded: true,
        agentReferences: [{
          kind: 'message',
          start: text.indexOf(href),
          end: text.indexOf(href) + href.length,
          href,
          sessionId: 'session-a',
          messageClientId: 'message-a',
          text: 'Target message body',
        }],
      }),
      msg('assistant', 'done'),
    ], opts);

    expect(handoff).not.toContain('cindy-composer-quote');
    expect(handoff).not.toContain(href);
    expect(handoff).toContain('Target message body');
  });

  it('超长文本被逐条截断,总长受硬上限保护', () => {
    const big = 'x'.repeat(50_000);
    const messages: HandoffSourceMessage[] = [];
    for (let i = 0; i < 20; i++) {
      messages.push(msg('user', big));
      messages.push(msg('assistant', big));
    }
    const text = buildHandoffText(messages, opts);
    expect(text.length).toBeLessThanOrEqual(16_000);
  });
});

describe('prependHandoffToUserMessage', () => {
  it('string 形态直接前拼', () => {
    expect(prependHandoffToUserMessage('新消息', 'HANDOFF')).toBe('HANDOFF\n\n新消息');
  });

  it('content string 形态前拼且保持结构', () => {
    expect(prependHandoffToUserMessage({ type: 'user', content: '新消息' }, 'H')).toEqual({
      type: 'user',
      content: 'H\n\n新消息',
    });
  });

  it('blocks 形态前插独立 text block,不改原 blocks', () => {
    const original = { type: 'user' as const, content: [{ type: 'text', text: '新消息' }] };
    const out = prependHandoffToUserMessage(original, 'H');
    expect(out).toEqual({
      type: 'user',
      content: [{ type: 'text', text: 'H' }, { type: 'text', text: '新消息' }],
    });
    expect(original.content).toHaveLength(1);
  });
});

describe('createAgentHandoffPendingRegistry', () => {
  it('set → peek 命中内存,consume 后不再注入且不回查 DB', async () => {
    const query = vi.fn(async () => 'from-db');
    const consumed = vi.fn();
    const reg = createAgentHandoffPendingRegistry(query, consumed);
    reg.set('s1', 'H1');
    expect(await reg.peek('s1')).toBe('H1');
    reg.consume('s1');
    expect(await reg.peek('s1')).toBeNull();
    expect(query).not.toHaveBeenCalled();
    expect(consumed).toHaveBeenCalledWith('s1');
  });

  it('内存 miss 时经 DB 重建并缓存(重启恢复语义)', async () => {
    const query = vi.fn(async () => 'from-db');
    const reg = createAgentHandoffPendingRegistry(query);
    expect(await reg.peek('s1')).toBe('from-db');
    expect(await reg.peek('s1')).toBe('from-db');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('DB 查询失败按无 pending 处理且不缓存(下次重查)', async () => {
    const query = vi.fn(async () => {
      throw new Error('db down');
    });
    const reg = createAgentHandoffPendingRegistry(query);
    expect(await reg.peek('s1')).toBeNull();
    expect(await reg.peek('s1')).toBeNull();
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('clear 后回落 DB 查询', async () => {
    const query = vi.fn(async () => null);
    const reg = createAgentHandoffPendingRegistry(query);
    reg.set('s1', 'H1');
    reg.clear('s1');
    expect(await reg.peek('s1')).toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe('buildHandoffText 工作状态区(社区 handoff packet 口径)', () => {
  const opts = { fromLabel: 'Claude Code', toLabel: 'Codex' };

  it('从 tool_use 提取改动文件(Claude Edit/Write 与 Codex apply_patch)与命令', () => {
    const text = buildHandoffText(
      [
        msg('user', '改代码'),
        msg('tool_use', { toolUseId: 't1', toolName: 'Edit', input: { file_path: '/repo/a.ts' } }),
        msg('tool_use', { toolUseId: 't2', toolName: 'Write', input: { file_path: '/repo/b.ts' } }),
        msg('tool_use', { toolUseId: 't3', toolName: 'apply_patch', input: { path: '/repo/c.ts' } }),
        msg('tool_use', { toolUseId: 't4', toolName: 'Bash', input: { command: 'pnpm test:unit' } }),
        msg('tool_use', { toolUseId: 't5', toolName: 'shell', input: { command: ['git', 'status', '--short'] } }),
        msg('assistant', '改好了'),
      ],
      opts,
    );
    expect(text).toContain('== 工作状态(自动提取)==');
    expect(text).toContain('- /repo/a.ts');
    expect(text).toContain('- /repo/b.ts');
    expect(text).toContain('- /repo/c.ts');
    expect(text).toContain('- pnpm test:unit');
    expect(text).toContain('- git status --short');
  });

  it('同一文件多次编辑去重;Read 等只读工具不进清单', () => {
    const text = buildHandoffText(
      [
        msg('user', 'q'),
        msg('tool_use', { toolUseId: 't1', toolName: 'Edit', input: { file_path: '/repo/a.ts' } }),
        msg('tool_use', { toolUseId: 't2', toolName: 'Edit', input: { file_path: '/repo/a.ts' } }),
        msg('tool_use', { toolUseId: 't3', toolName: 'Read', input: { file_path: '/repo/readonly.ts' } }),
      ],
      opts,
    );
    expect(text.match(/- \/repo\/a\.ts/g)).toHaveLength(1);
    // Read 的路径可出现在对话区的工具行,但不得进「改动过的文件」清单(行首 '- ')
    expect(text).not.toContain('- /repo/readonly.ts');
  });

  it('无工具活动时不渲染工作状态区', () => {
    const text = buildHandoffText([msg('user', '你好'), msg('assistant', '你好!')], opts);
    expect(text).not.toContain('== 工作状态');
  });

  it('framing 包含「先核对工作区、以工作区为准」纪律', () => {
    const text = buildHandoffText([msg('user', 'q')], opts);
    expect(text).toContain('git status');
    expect(text).toContain('以工作区现状为准');
  });
});

describe('buildHandoffText 早期原文检索指引', () => {
  const opts = { fromLabel: 'Claude Code', toLabel: 'Codex' };

  it('提供 sessionId 时附带检索指引(两个工具名 + session_ids 定向)', () => {
    const text = buildHandoffText([msg('user', '你好')], { ...opts, sessionId: 'sess-abc' });
    expect(text).toContain('== 早期原文检索(需要时用)==');
    expect(text).toContain('本会话 id:sess-abc');
    expect(text).toContain('search_chat_history');
    expect(text).toContain('get_chat_history');
    expect(text).toContain('"session_ids":["sess-abc"]');
    // 指引在结束标记之前
    expect(text.indexOf('早期原文检索')).toBeLessThan(text.indexOf('交接说明结束'));
  });

  it('不提供 sessionId 时不渲染检索指引', () => {
    const text = buildHandoffText([msg('user', '你好')], opts);
    expect(text).not.toContain('早期原文检索');
    expect(text).not.toContain('get_chat_history');
  });
});

describe('buildHandoffText 增量(delta)模式:切回停泊引擎', () => {
  const opts = { fromLabel: 'Codex', toLabel: 'Claude Code', mode: 'delta' as const };

  it('framing 为归位续接口径,不用全量交接的"此前由 X 驱动"措辞', () => {
    const text = buildHandoffText([msg('user', '离开期间的问题'), msg('assistant', '回答')], opts);
    expect(text).toContain('你(Claude Code)此前处理过本会话');
    expect(text).toContain('切回由你继续');
    expect(text).toContain('你离开期间发生的进展记录');
    expect(text).not.toContain('现在起由你(Claude Code)继续');
    // 纪律保留:不向用户提及 + 以工作区为准
    expect(text).toContain('不要向用户提及本段交接说明');
    expect(text).toContain('以工作区现状为准');
    expect(text.trimEnd().endsWith('== 交接说明结束,以下是用户的新消息 ==')).toBe(true);
  });

  it('工作状态区按 workStateMessages(全量历史)提取,对话区只含增量', () => {
    const full: HandoffSourceMessage[] = [
      msg('user', '最早的问题'),
      msg('tool_use', { toolUseId: 't1', toolName: 'Edit', input: { file_path: '/repo/early.ts' } }),
      msg('user', '离开期间的问题'),
    ];
    const delta: HandoffSourceMessage[] = [msg('user', '离开期间的问题', 200)];
    const text = buildHandoffText(delta, { ...opts, workStateMessages: full });
    expect(text).toContain('- /repo/early.ts'); // 全量工作状态
    expect(text).toContain('离开期间的问题');
    expect(text).not.toContain('最早的问题'); // 对话区不含水位线之前的内容
    expect(text).toContain('== 你离开期间的对话记录 ==');
  });

  it('空增量(切走后立即切回)显式说明,不留歧义', () => {
    const text = buildHandoffText([], opts);
    expect(text).toContain('== 你离开期间没有新的对话消息 ==');
  });

  it('delta 模式同样附带检索指引(sessionId 提供时)', () => {
    const text = buildHandoffText([msg('user', 'q')], { ...opts, sessionId: 'sess-d1' });
    expect(text).toContain('== 早期原文检索(需要时用)==');
    expect(text).toContain('"session_ids":["sess-d1"]');
  });

  it('full 模式(缺省)不受 delta 文案影响', () => {
    const text = buildHandoffText([msg('user', 'q')], { fromLabel: 'Codex', toLabel: 'Claude Code' });
    expect(text).toContain('现在起由你(Claude Code)继续');
    expect(text).not.toContain('切回由你继续');
    expect(text).not.toContain('你离开期间没有新的对话消息');
  });
});

describe('buildHandoffText 超限收缩保住首尾', () => {
  it('极端长对话下检索指引与结束标记不被截掉(收缩逐字区而非切尾)', () => {
    const big = 'x'.repeat(50_000);
    const messages: HandoffSourceMessage[] = [];
    for (let i = 0; i < 20; i++) {
      messages.push(msg('user', big));
      messages.push(msg('assistant', big));
    }
    const text = buildHandoffText(messages, {
      fromLabel: 'Claude Code',
      toLabel: 'Codex',
      sessionId: 'sess-tail',
    });
    expect(text.length).toBeLessThanOrEqual(16_000);
    expect(text).toContain('== 早期原文检索(需要时用)==');
    expect(text).toContain('"session_ids":["sess-tail"]');
    expect(text.trimEnd().endsWith('== 交接说明结束,以下是用户的新消息 ==')).toBe(true);
  });

  it('单轮 100 条 tool_use 折叠中部,且硬上限/检索段/结束标记全部存活', () => {
    const messages: HandoffSourceMessage[] = [msg('user', '执行大量工具')];
    for (let i = 0; i < 100; i++) {
      messages.push(msg('tool_use', {
        toolUseId: `tool-${i}`,
        toolName: 'Read',
        input: { file_path: `/repo/${i}-${'x'.repeat(200)}.ts` },
      }));
    }
    const text = buildHandoffText(messages, {
      fromLabel: 'Claude Code',
      toLabel: 'Codex',
      sessionId: 'sess-tools',
    });
    expect(text.length).toBeLessThanOrEqual(16_000);
    expect(text).toContain('(中间 60 条工具调用略)');
    expect(text).toContain('== 早期原文检索(需要时用)==');
    expect(text).toContain('"session_ids":["sess-tools"]');
    expect(text.trimEnd().endsWith('== 交接说明结束,以下是用户的新消息 ==')).toBe(true);
  });
});
