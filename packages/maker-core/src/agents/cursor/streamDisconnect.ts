/**
 * Cursor agent 上游断流错误 reason key。
 *
 * 当 Cursor ACP 在 prompt 期间遇到上游 HTTP/2 / SSE 流被打断（如
 * `RetriableError: [canceled] http/2 stream closed with error code CANCEL (0x8)`）
 * 时，由 maker-core 分类并在 AgentEvent.error 的 data.reason 中盖上此 key。
 * desktop 侧的中断自愈判据（isInterruptedTurnError）以此 key 识别可续跑的断流。
 */
export const CURSOR_STREAM_DISCONNECT_REASON = 'cursor-stream-disconnect';

/**
 * 排除项：确定不可重试或非上游断流的形态。
 * 白名单前置拦截，比黑名单更稳固：任何带以下签名的错误必须归为 false。
 */
const EXCLUSION_PATTERNS = [
  /acp (?:client |transport )?closed/i,
  /stdio transport closed/i,
  /transport failure/i,
  /session\s+(?:"[^"]+"|'[^']+'|[0-9a-f-]{8,})\s+not found/i,
  /timed? ?out|timeout|watchdog/i,
  /invalid[ _]params|method not found|invalid request/i,
  /unauthorized|authentication|invalid token/i,
  /quota|billing|payment required/i,
];

/**
 * 白名单项：可确定为 Cursor ACP 上游断流的形态。
 */
const WHITELIST_PATTERNS = [
  /http\/2 stream closed/i,
  /stream closed with error code/i,
  /CANCEL \(0x[0-9a-f]+\)/i,
  /connection closed mid-response/i,
  /stream (?:closed|ended|interrupted) (?:unexpectedly|mid-response)/i,
  /stream (?:closed|ended|interrupted) with error/i,
  /http\/2 stream error/i,
];

/**
 * 判断是否为 Cursor ACP 上游断流错误（纯函数，白名单制）。
 *
 * @param value 捕获到的错误对象或 raw 消息
 */
export function isCursorStreamDisconnectError(value: unknown): boolean {
  const texts = collectErrorTexts(value);
  if (texts.length === 0) return false;

  for (const text of texts) {
    if (EXCLUSION_PATTERNS.some((pattern) => pattern.test(text))) {
      return false;
    }
    if (WHITELIST_PATTERNS.some((pattern) => pattern.test(text))) {
      return true;
    }
  }

  return false;
}

function collectErrorTexts(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (value instanceof Error) {
    const texts = [value.message];
    const data = (value as Error & { data?: unknown }).data;
    if (typeof data === 'string') texts.push(data);
    else if (isRecord(data)) {
      if (typeof data.message === 'string') texts.push(data.message);
    }
    return texts;
  }
  if (!isRecord(value)) return [];
  const texts: string[] = [];
  if (typeof value.message === 'string') texts.push(value.message);
  if (isRecord(value.data) && typeof value.data.message === 'string') {
    texts.push(value.data.message);
  }
  if (typeof value.data === 'string') texts.push(value.data);
  return texts;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
