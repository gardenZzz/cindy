/**
 * Cursor ACP resume 失败分类器。
 *
 * 只接受上游明确的「session 不存在」错误；网络 / 超时 / 任意 RPC 失败
 * 不得触发 onInvalidResumeSession CAS。
 *
 * Cursor 实测错误形：
 *   { code: -32602, message: "Invalid params",
 *     data: { message: 'Session "uuid" not found' } }
 */

export function isCursorResumeSessionNotFound(
  value: unknown,
  expectedSessionId: string,
): boolean {
  if (!expectedSessionId) return false;
  for (const text of collectErrorTexts(value)) {
    const match =
      /Session\s+"([^"]+)"\s+not found/i.exec(text) ??
      /Session\s+'([^']+)'\s+not found/i.exec(text) ??
      /session\s+([0-9a-f-]{8,})\s+not found/i.exec(text);
    if (!match) {
      // 无 id 的泛化文案：仅当整段错误同时带 expected id 才认
      if (/not found/i.test(text) && text.includes(expectedSessionId)) return true;
      continue;
    }
    const reported = match[1]?.replace(/[.,;!?]+$/, '');
    if (!reported || reported === expectedSessionId) return true;
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
