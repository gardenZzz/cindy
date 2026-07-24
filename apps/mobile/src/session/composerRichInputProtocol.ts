export type ComposerWebMessage =
  | { type: 'ready' | 'focus' | 'blur' }
  | { type: 'height'; height: number }
  | { type: 'change'; document: unknown }
  | { type: 'paste-text-request'; requestId: string; text?: string }
  | { type: 'paste-images-start'; requestId: string; count: number }
  | { type: 'paste-image'; requestId: string; base64: string; mimeType: string; name: string; index: number }
  | { type: 'paste-image-failed'; requestId: string; index: number };

export const MAX_PASTED_IMAGE_COUNT = 20;
export const MAX_PASTED_IMAGE_BASE64_CHARS = 40_000_000;
export const MAX_PASTED_IMAGE_NAME_CHARS = 255;
export const MAX_PASTED_TEXT_CHARS = 4_000_000;
const MAX_PASTE_REQUEST_ID_CHARS = 64;
export const SUPPORTED_PASTED_IMAGE_MIME_TYPES = [
  'image/gif',
  'image/heic',
  'image/heif',
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;
const SUPPORTED_PASTED_IMAGE_MIME_TYPE_SET = new Set<string>(
  SUPPORTED_PASTED_IMAGE_MIME_TYPES,
);

/** Parse the untrusted WebView bridge payload into the small native protocol. */
export function parseComposerWebMessage(raw: string): ComposerWebMessage | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return null;
    const message = value as Record<string, unknown>;
    if (
      message.type === 'ready'
      || message.type === 'focus'
      || message.type === 'blur'
    ) return { type: message.type };
    if (message.type === 'height') {
      return typeof message.height === 'number' && Number.isFinite(message.height)
        ? { type: 'height', height: message.height }
        : null;
    }
    if (message.type === 'change') {
      return { type: 'change', document: message.document };
    }
    if (message.type === 'paste-text-request') {
      if (
        typeof message.requestId !== 'string'
        || message.requestId.length === 0
        || message.requestId.length > MAX_PASTE_REQUEST_ID_CHARS
        || (message.text !== undefined && (
          typeof message.text !== 'string'
          || message.text.length > MAX_PASTED_TEXT_CHARS
        ))
      ) return null;
      return {
        type: 'paste-text-request',
        requestId: message.requestId,
        ...(typeof message.text === 'string' ? { text: message.text } : {}),
      };
    }
    if (message.type === 'paste-images-start') {
      return isValidRequestId(message.requestId) && isBoundedImageIndex(message.count, 1)
        ? { type: 'paste-images-start', requestId: message.requestId, count: message.count }
        : null;
    }
    if (message.type === 'paste-image-failed') {
      return isValidRequestId(message.requestId) && isBoundedImageIndex(message.index, 0)
        ? { type: 'paste-image-failed', requestId: message.requestId, index: message.index }
        : null;
    }
    if (message.type === 'paste-image') {
      if (
        !isValidRequestId(message.requestId)
        || typeof message.base64 !== 'string'
        || message.base64.length === 0
        || message.base64.length > MAX_PASTED_IMAGE_BASE64_CHARS
        || typeof message.mimeType !== 'string'
        || !SUPPORTED_PASTED_IMAGE_MIME_TYPE_SET.has(message.mimeType)
        || typeof message.name !== 'string'
        || message.name.length > MAX_PASTED_IMAGE_NAME_CHARS
        || !isBoundedImageIndex(message.index, 0)
      ) return null;
      return {
        type: 'paste-image',
        requestId: message.requestId,
        base64: message.base64,
        mimeType: message.mimeType,
        name: message.name,
        index: message.index,
      };
    }
    return null;
  } catch {
    return null;
  }
}

function isValidRequestId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_PASTE_REQUEST_ID_CHARS;
}

function isBoundedImageIndex(value: unknown, minimum: number): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= minimum
    && value <= MAX_PASTED_IMAGE_COUNT;
}
