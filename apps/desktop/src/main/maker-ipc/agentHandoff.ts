/**
 * 原生 Agent 会话重建时的交接(handoff)构造与注入工具。当前用于跨引擎切换
 * 和消息删除后的同引擎上下文重建。
 *
 * 设计原则(规则 9:代码保证确定性):
 *  - 交接文本由代码从 DB 消息历史确定性拼接——最近 K 轮逐字(带截断)+ 更早轮次
 *    单行提要,不经 LLM 生成,零额外延迟、可单测、可复现。
 *  - 注入走"wire 前缀"通道:发给新引擎的 payload 前置交接段,落库/渲染仍是用户
 *    原文(display 与 sent 分离,复用 persistUserMessage 既有机制)。
 *  - 交接全文持久化在 agent_switch 边界或隐藏的 context_rebuild 行中，重启后
 *    pending 状态可从 DB 确定性重建(无额外状态列)。
 */

import { projectPersistedAgentFacingUserText } from '@cindy/maker-shared/agent-input-projection';

/** DB 层引擎标识(sessions.agent_kind / messages.agent_kind 的值域)。 */
export type DbAgentKind = 'cc' | 'codex';

/** 构造交接文本所需的最小消息投影(content 已 JSON.parse,即 camel Message.content)。 */
export interface HandoffSourceMessage {
  role: string;
  content: unknown;
  createdAt: number; // unix ms
}

export interface BuildHandoffOptions {
  /** 展示给模型的旧引擎名(如 'Claude Code')。 */
  fromLabel: string;
  /** 展示给模型的新引擎名(如 'Codex')。 */
  toLabel: string;
  /**
   * business 层会话 id。提供时交接文本附带「早期原文检索」指引——新引擎可用
   * cindy_helper 的 get_chat_history / search_chat_history(带 session_ids
   * 定向过滤)按需检索本会话完整历史:摘要管大局、检索管细节,消除逐字窗口外
   * 的细节性失忆。两家引擎的会话都挂了该 MCP server。
   */
  sessionId?: string;
  /**
   * Phase 2(切回复用停泊原生会话):
   *  - 'full'(缺省)= 目标引擎全新原生会话,交接覆盖整场对话;
   *  - 'delta' = 目标引擎 resume 自己的停泊原生会话,已持有离场前的完整记忆,
   *    messages 只传"离场期间"的增量,framing 改为归位续接口径。
   */
  mode?: 'full' | 'delta';
  /**
   * 工作状态区(改动文件/命令清单)的提取源,缺省 = messages。delta 模式传
   * 全量历史:文件/命令清单是最耐久的交接载体,即使 resume 静默失效(原生
   * 会话过期等不可检测场景),增量交接也保有全局工作现场,不至于失明。
   */
  workStateMessages?: HandoffSourceMessage[];
  /**
   * 交接触发原因。message-deletion 表示同一引擎因本地消息被删除而重建原生
   * 上下文；framing 会要求只采用删除后的有效历史，且不向用户暴露内部重建。
   */
  reason?: 'agent-switch' | 'message-deletion';
}

/** 最近多少个用户轮次进入逐字区(其余进单行提要区)。 */
const RECENT_TURNS = 4;
/** 逐字区单条 user / assistant 文本上限(字符)。 */
const RECENT_TEXT_CAP = 2000;
/** 工具调用行的 input 摘要上限(字符)。 */
const TOOL_INPUT_CAP = 160;
/** 提要区总预算(字符),超出时从最旧行开始丢弃。 */
const DIGEST_BUDGET = 3000;
/** 提要区单行上限(字符)。 */
const DIGEST_LINE_CAP = 120;
/** 最终交接文本硬上限(字符)——最后一道保险,正常路径不应触达。 */
const HANDOFF_HARD_CAP = 16000;
/** 单轮详细行最多保留首尾各 20 条；防工具密集轮撑爆全部预算。 */
const DETAIL_LINES_EDGE_CAP = 20;
/** 工具密集/多 assistant block 单轮的详细区字符预算。 */
const DETAIL_LINES_CHAR_BUDGET = 9000;
const DETAIL_LINE_COMPACT_CAP = 240;

/** 合成指令行前缀(makerChatStore isSyntheticTrigger 同款标记),不进交接。 */
const SYNTHETIC_TRIGGER_PREFIX = '[UI_ACTION_TRIGGER]';

/** 工作状态区:改动文件清单上限。 */
const CHANGED_FILES_CAP = 20;
/** 工作状态区:命令清单上限(取最近 N 条)。 */
const COMMANDS_CAP = 10;
/** 工作状态区:单条命令摘要上限(字符)。 */
const COMMAND_LINE_CAP = 120;

/** 会写文件的工具名(Claude 系 + Codex 系),input 里带路径字段。 */
const FILE_EDIT_TOOL_NAMES = new Set([
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'apply_patch',
  'str_replace_editor',
]);
/** 执行命令的工具名(Claude Bash / Codex shell 系)。 */
const COMMAND_TOOL_NAMES = new Set(['Bash', 'shell', 'exec_command', 'local_shell']);

function truncate(text: string, cap: number): string {
  if (text.length <= cap) return text;
  return `${text.slice(0, cap)}…(截断)`;
}

/** 折叠换行成单行(提要区用)。 */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * 从持久化 content 中容错抽取纯文本。支持三种历史形态(对齐 renderer
 * parseUserContent 的分支语义,但此处只取 text,不管附件):
 *  1. string —— 纯文本,或 JSON 序列化后的 {text,...} / SDK blocks;
 *  2. array —— SDK content blocks,拼接 text block;
 *  3. object —— {text, images, files}(stringifyUserContent 形态)或 {text} / {message}。
 */
export function extractPlainText(content: unknown): string {
  if (typeof content === 'string') {
    if (content.length === 0) return '';
    const first = content[0];
    if (first === '{' || first === '[') {
      try {
        return extractPlainText(JSON.parse(content));
      } catch {
        return content;
      }
    }
    return content;
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block && typeof block === 'object') {
        const b = block as Record<string, unknown>;
        if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
      }
    }
    return parts.join('\n');
  }
  if (content && typeof content === 'object') {
    const c = content as Record<string, unknown>;
    if (typeof c.text === 'string') {
      return projectPersistedAgentFacingUserText(c) ?? c.text;
    }
    if (typeof c.message === 'string') return c.message;
  }
  return '';
}

interface Turn {
  userText: string;
  /** 轮内按序的展示行(assistant 文本 / 工具行 / 错误行)。 */
  detailLines: string[];
  /** 轮内最后一段 assistant 文本(提要区用)。 */
  lastAssistantText: string;
}

/**
 * 工作状态(结构化,社区 handoff packet 公认最有价值的部分——比对话记录更耐久):
 * 从 tool_use 行确定性提取改动文件与执行过的命令。见 knightli 交接手册 /
 * claude-handoff 的字段收敛:Changed Files / Verification Run。
 */
interface WorkState {
  changedFiles: string[];
  commands: string[];
}

function extractWorkState(messages: HandoffSourceMessage[]): WorkState {
  const files = new Set<string>();
  const commands: string[] = [];
  for (const msg of messages) {
    if (msg.role !== 'tool_use' || !msg.content || typeof msg.content !== 'object') continue;
    const c = msg.content as Record<string, unknown>;
    const name = typeof c.toolName === 'string' ? c.toolName : '';
    const input = (c.input && typeof c.input === 'object' ? c.input : {}) as Record<string, unknown>;
    if (FILE_EDIT_TOOL_NAMES.has(name)) {
      for (const key of ['file_path', 'path', 'notebook_path']) {
        const v = input[key];
        if (typeof v === 'string' && v) files.add(v);
      }
    } else if (COMMAND_TOOL_NAMES.has(name)) {
      const raw = input.command;
      const cmd = typeof raw === 'string'
        ? raw
        : Array.isArray(raw)
          ? raw.filter((x) => typeof x === 'string').join(' ')
          : '';
      if (cmd) commands.push(truncate(oneLine(cmd), COMMAND_LINE_CAP));
    }
  }
  return {
    changedFiles: [...files].slice(-CHANGED_FILES_CAP),
    commands: commands.slice(-COMMANDS_CAP),
  };
}

/** 把消息流按 user 行切成轮次。首个 user 行之前的孤儿行并入首轮 detail。 */
function splitTurns(messages: HandoffSourceMessage[]): Turn[] {
  const turns: Turn[] = [];
  let current: Turn | null = null;
  for (const msg of messages) {
    if (msg.role === 'user') {
      const text = extractPlainText(msg.content);
      if (text.startsWith(SYNTHETIC_TRIGGER_PREFIX)) continue;
      current = { userText: text, detailLines: [], lastAssistantText: '' };
      turns.push(current);
      continue;
    }
    if (!current) {
      current = { userText: '', detailLines: [], lastAssistantText: '' };
      turns.push(current);
    }
    switch (msg.role) {
      case 'assistant': {
        const text = extractPlainText(msg.content);
        if (text) {
          current.detailLines.push(`[助手]\n${truncate(text, RECENT_TEXT_CAP)}`);
          current.lastAssistantText = text;
        }
        break;
      }
      case 'tool_use': {
        const c = (msg.content ?? {}) as Record<string, unknown>;
        const name = typeof c.toolName === 'string' ? c.toolName : '(unknown)';
        let inputDigest = '';
        try {
          inputDigest = c.input === undefined ? '' : JSON.stringify(c.input);
        } catch {
          inputDigest = '';
        }
        current.detailLines.push(`[工具] ${name}${inputDigest ? `: ${truncate(inputDigest, TOOL_INPUT_CAP)}` : ''}`);
        break;
      }
      case 'error': {
        const text = extractPlainText(msg.content);
        if (text) current.detailLines.push(`[错误] ${truncate(oneLine(text), 200)}`);
        break;
      }
      case 'ask_user': {
        current.detailLines.push('[向用户提问并获得了回答]');
        break;
      }
      case 'plan_review': {
        current.detailLines.push('[提交了计划供用户审阅]');
        break;
      }
      default:
        // thinking / agent_switch / tool_result 等不进交接正文
        break;
    }
  }
  return turns;
}

function collapseDetailLines(lines: string[]): string[] {
  const totalChars = lines.reduce((sum, line) => sum + line.length + 1, 0);
  const normalized = totalChars > DETAIL_LINES_CHAR_BUDGET
    ? lines.map((line) => truncate(line, DETAIL_LINE_COMPACT_CAP))
    : lines;
  const kept = DETAIL_LINES_EDGE_CAP * 2;
  if (normalized.length <= kept) return normalized;
  const omitted = normalized.length - kept;
  return [
    ...normalized.slice(0, DETAIL_LINES_EDGE_CAP),
    `(中间 ${omitted} 条工具调用略)`,
    ...normalized.slice(-DETAIL_LINES_EDGE_CAP),
  ];
}

/**
 * 确定性构造交接文本:framing(第一人称续接 + 不向用户提及)+ 更早轮次提要 +
 * 最近 RECENT_TURNS 轮逐字记录。总长受各区预算约束,最终有 HANDOFF_HARD_CAP 保险。
 */
export function buildHandoffText(
  messages: HandoffSourceMessage[],
  opts: BuildHandoffOptions,
): string {
  const turns = splitTurns(messages);
  // 超出硬上限时逐档收缩逐字区(4→3→2→1 轮)重组——绝不能从尾部硬切:
  // 检索指引与结束标记在尾部,是最不能丢的段。收缩到 1 轮仍超限才走最后的
  // 尾部截断保险(实际不可达:各区预算之和 < 上限)。
  for (let recentCount = RECENT_TURNS; recentCount >= 1; recentCount--) {
    const text = assembleHandoffText(turns, messages, opts, recentCount);
    if (text.length <= HANDOFF_HARD_CAP || recentCount === 1) {
      return text.length > HANDOFF_HARD_CAP ? text.slice(0, HANDOFF_HARD_CAP) : text;
    }
  }
  /* istanbul ignore next -- 循环必然 return */
  return assembleHandoffText(turns, messages, opts, 1).slice(0, HANDOFF_HARD_CAP);
}

function assembleHandoffText(
  turns: Turn[],
  messages: HandoffSourceMessage[],
  opts: BuildHandoffOptions,
  recentCount: number,
): string {
  const recent = turns.slice(-recentCount);
  const earlier = turns.slice(0, -recentCount);

  const sections: string[] = [];
  if (opts.reason === 'message-deletion') {
    sections.push(
      `[会话上下文重建·内部上下文]\n` +
        `本会话的本地记录已由用户编辑,当前原生会话上下文因此失效。` +
        `下面是编辑后的有效对话历史;只把这些记录视为此前对话,不要尝试恢复、引用或推断未列出的消息。` +
        `请以第一人称自然续接,不要向用户提及本段重建说明。` +
        `开始改动前先核对工作区实际状态(如 git status / git diff / 读相关文件):` +
        `记述与工作区冲突时,一律以工作区现状为准;` +
        `对更早的细节没有把握时,优先读取实际文件与代码核实,不要凭摘要臆断。`,
    );
  } else if (opts.mode === 'delta') {
    // 归位续接:目标引擎 resume 了自己的停泊原生会话,已持有离场前的完整记忆。
    // 只补"离开期间"的进展;同时防御 resume 静默失效——指引它以工作区与检索为准,
    // 而不是断言"你一定记得"。
    sections.push(
      `[会话交接·内部上下文]\n` +
        `你(${opts.toLabel})此前处理过本会话,期间曾切换给 ${opts.fromLabel} 引擎接手,现在切回由你继续。` +
        `你离场前的对话记忆应仍然有效;下面是你离开期间发生的进展记录,请合并进你的理解后以第一人称自然续接。` +
        `不要向用户提及本段交接说明,也不要提及引擎切换过程。` +
        `开始改动前先核对工作区实际状态(如 git status / git diff / 读相关文件):` +
        `记述、你的记忆与工作区三者冲突时,一律以工作区现状为准;` +
        `对离开期间的细节没有把握时,优先读取实际文件与代码核实,不要凭摘要臆断。`,
    );
  } else {
    sections.push(
      `[会话交接·内部上下文]\n` +
        `本会话此前由 ${opts.fromLabel} 引擎驱动,现在起由你(${opts.toLabel})继续。` +
        `下面是这场对话的既往记录——这是你与用户之间同一场对话的延续,请以第一人称自然续接。` +
        `不要向用户提及本段交接说明,不要说"根据交接摘要/记录"之类的话。` +
        `开始改动前先核对工作区实际状态(如 git status / git diff / 读相关文件):` +
        `记述与工作区冲突时,一律以工作区现状为准;` +
        `对更早的细节没有把握时,优先读取实际文件与代码核实,不要凭摘要臆断。`,
    );
  }

  // 工作状态区(结构化):比对话记录更耐久的交接载体——新引擎据此了解
  // 动过哪些文件、跑过哪些命令,避免重复劳动或誤判"还没做过"。
  // delta 模式按 workStateMessages(全量历史)提取,见 BuildHandoffOptions 注释。
  const work = extractWorkState(opts.workStateMessages ?? messages);
  if (work.changedFiles.length > 0 || work.commands.length > 0) {
    const lines: string[] = [];
    if (work.changedFiles.length > 0) {
      lines.push('改动过的文件:');
      for (const f of work.changedFiles) lines.push(`- ${f}`);
    }
    if (work.commands.length > 0) {
      lines.push('执行过的命令(最近几条):');
      for (const cmd of work.commands) lines.push(`- ${cmd}`);
    }
    sections.push(`== 工作状态(自动提取)==\n${lines.join('\n')}`);
  }

  if (earlier.length > 0) {
    const lines: string[] = [];
    for (const t of earlier) {
      if (t.userText) lines.push(`- 用户: ${truncate(oneLine(t.userText), DIGEST_LINE_CAP)}`);
      if (t.lastAssistantText) {
        lines.push(`  回应: ${truncate(oneLine(t.lastAssistantText), DIGEST_LINE_CAP)}`);
      }
    }
    // 预算内保留最新的提要行,最旧的先丢
    let digest = lines.join('\n');
    if (digest.length > DIGEST_BUDGET) {
      const kept: string[] = [];
      let used = 0;
      for (let i = lines.length - 1; i >= 0; i--) {
        const cost = lines[i].length + 1;
        if (used + cost > DIGEST_BUDGET) break;
        kept.unshift(lines[i]);
        used += cost;
      }
      digest = `(更早内容已省略)\n${kept.join('\n')}`;
    }
    sections.push(
      opts.mode === 'delta'
        ? `== 你离开期间·较早进展提要 ==\n${digest}`
        : `== 较早对话提要 ==\n${digest}`,
    );
  }

  if (recent.length > 0) {
    const blocks: string[] = [];
    for (const t of recent) {
      const parts: string[] = [];
      if (t.userText) parts.push(`[用户]\n${truncate(t.userText, RECENT_TEXT_CAP)}`);
      parts.push(...collapseDetailLines(t.detailLines));
      if (parts.length > 0) blocks.push(parts.join('\n'));
    }
    sections.push(
      opts.mode === 'delta'
        ? `== 你离开期间的对话记录 ==\n${blocks.join('\n---\n')}`
        : `== 最近对话记录 ==\n${blocks.join('\n---\n')}`,
    );
  } else if (opts.mode === 'delta') {
    // 切走后一条消息都没发就切回:显式说明,避免引擎误以为漏了记录。
    sections.push('== 你离开期间没有新的对话消息 ==');
  }

  if (opts.sessionId) {
    // 早期原文检索指引:逐字窗口外的内容只剩单行提要,用户追问细节时模型必须能
    // 翻到原文。工具名 / 参数是确定性事实(@cindy/mcps xdt-helper,session_ids 过滤,
    // 两个工具均支持),写死在指引里比让模型自己发现可靠(规则 9)。
    sections.push(
      `== 早期原文检索(需要时用)==\n` +
        `本会话 id:${opts.sessionId}\n` +
        `以上摘要之外的早期对话原文可随时检索(工具在 cindy_helper 的 history 类目):\n` +
        `- 按内容找:search_chat_history,args {"query":"<关键词>","session_ids":["${opts.sessionId}"]}\n` +
        `- 按时间/角色拉原文:get_chat_history,args {"session_ids":["${opts.sessionId}"],"roles":["user","assistant"]}(hasMore 用 nextCursor 翻页)\n` +
        `用户追问的细节不在上文时,先检索原文再回答,不要凭提要猜;检索到的旧内容与工作区现状冲突时,以工作区为准。仅在需要时使用,不必每轮都查。`,
    );
  }

  sections.push(
    opts.reason === 'message-deletion'
      ? '== 上下文重建说明结束,以下是用户的新消息 =='
      : '== 交接说明结束,以下是用户的新消息 ==',
  );
  // 不在组装阶段做任何截断——超限收缩由 buildHandoffText 的外层循环负责
  // (收缩逐字区保住首尾),尾部硬切只是外层最后的保险。
  return sections.join('\n\n');
}

/** send 路径的 wire 消息形态(与 makerSendTransaction 的 IpcUserMessage 对齐)。 */
export type HandoffWireMessage =
  | string
  | { type: 'user'; content: string | Array<{ type: string; [k: string]: unknown }> };

/**
 * 把交接文本前置到发给 agent 的 wire 消息上(不影响落库/显示内容)。
 * blocks 形态下前插独立 text block,string 形态下直接前拼。
 */
export function prependHandoffToUserMessage(
  message: HandoffWireMessage,
  handoff: string,
): HandoffWireMessage {
  if (typeof message === 'string') {
    return `${handoff}\n\n${message}`;
  }
  if (typeof message.content === 'string') {
    return { ...message, content: `${handoff}\n\n${message.content}` };
  }
  return { ...message, content: [{ type: 'text', text: handoff }, ...message.content] };
}

/**
 * pending-handoff 注册表:切换后"下一条 user 消息注入交接前缀"的状态。
 *  - 内存 Map 为一级缓存(null = 已确认无 pending);
 *  - miss 时(app 重启后首次 send)经注入的 queryPending 从 DB 确定性重建
 *    ("最后一条 agent_switch 行之后没有 user 行" ⟺ pending);
 *  - consume 仅在 vendor dispatch 跨过不可逆边界(accepted)后调用,失败保留
 *    pending 下次重试。
 */
export interface AgentHandoffPendingRegistry {
  set(sessionId: string, handoff: string): void;
  peek(sessionId: string): Promise<string | null>;
  consume(sessionId: string): void;
  /** session 删除 / 关闭清理,避免 Map 泄漏。 */
  clear(sessionId: string): void;
}

export function createAgentHandoffPendingRegistry(
  queryPending: (sessionId: string) => Promise<string | null>,
  onConsume?: (sessionId: string) => void,
): AgentHandoffPendingRegistry {
  const pending = new Map<string, string | null>();
  return {
    set(sessionId, handoff) {
      pending.set(sessionId, handoff);
    },
    async peek(sessionId) {
      if (pending.has(sessionId)) return pending.get(sessionId) ?? null;
      let fromDb: string | null = null;
      try {
        fromDb = await queryPending(sessionId);
      } catch {
        // 查询失败按无 pending 处理(不阻塞发送);下次 send 重查。
        return null;
      }
      pending.set(sessionId, fromDb);
      return fromDb;
    },
    consume(sessionId) {
      pending.set(sessionId, null);
      onConsume?.(sessionId);
    },
    clear(sessionId) {
      pending.delete(sessionId);
    },
  };
}
