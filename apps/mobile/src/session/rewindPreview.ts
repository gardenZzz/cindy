import type { ChatQuote } from '@cindy/maker-shared/chat-quotes';
import type { ComposerDocument } from '@/session/composerDocument';

export interface RewindPreviewPayload {
  canRewind: boolean;
  error?: string;
  filesChanged?: string[];
  insertions?: number;
  deletions?: number;
}

export type RewindPreviewState =
  | { kind: 'idle' }
  | {
      kind: 'loading';
      clientId: string;
      draftText: string;
      draftQuotes: readonly ChatQuote[];
      draftOrderedBody?: string;
      draftDocument?: ComposerDocument;
    }
  | {
      kind: 'default';
      clientId: string;
      draftText: string;
      draftQuotes: readonly ChatQuote[];
      draftOrderedBody?: string;
      draftDocument?: ComposerDocument;
      filesChanged: string[];
      insertions: number;
      deletions: number;
    }
  | {
      kind: 'empty';
      clientId: string;
      draftText: string;
      draftQuotes: readonly ChatQuote[];
      draftOrderedBody?: string;
      draftDocument?: ComposerDocument;
      note?: string;
    }
  | {
      kind: 'error';
      clientId: string;
      draftText: string;
      draftQuotes: readonly ChatQuote[];
      draftOrderedBody?: string;
      draftDocument?: ComposerDocument;
      errorText: string;
    };

export type CommitReadyRewindState = Extract<RewindPreviewState, { kind: 'default' | 'empty' }>;

export function buildRewindPreviewState(
  clientId: string,
  draftText: string,
  raw: unknown,
  draftQuotes: readonly ChatQuote[] = [],
  draftOrderedBody?: string,
  draftDocument?: ComposerDocument,
): RewindPreviewState {
  const orderedDraft = draftOrderedBody ? { draftOrderedBody } : {};
  const documentDraft = draftDocument ? { draftDocument } : {};
  const payload = normalizeRewindPreviewPayload(raw);
  if (!payload) {
    return {
      kind: 'error',
      clientId,
      draftText,
      draftQuotes,
      ...orderedDraft,
      ...documentDraft,
      errorText: '无法读取回退预览结果，请重新同步后再试。',
    };
  }

  const files = payload.filesChanged ?? [];
  if (payload.canRewind && files.length > 0) {
    return {
      kind: 'default',
      clientId,
      draftText,
      draftQuotes,
      ...orderedDraft,
      ...documentDraft,
      filesChanged: files,
      insertions: payload.insertions ?? 0,
      deletions: payload.deletions ?? 0,
    };
  }

  if (payload.canRewind) {
    return { kind: 'empty', clientId, draftText, draftQuotes, ...orderedDraft, ...documentDraft };
  }

  return {
    kind: 'empty',
    clientId,
    draftText,
    draftQuotes,
    ...orderedDraft,
    ...documentDraft,
    note: payload.error || '没有可回滚的文件，将只截断这条消息之后的对话历史。',
  };
}

export function isCommitReadyRewindState(state: RewindPreviewState): state is CommitReadyRewindState {
  return state.kind === 'default' || state.kind === 'empty';
}

function normalizeRewindPreviewPayload(value: unknown): RewindPreviewPayload | null {
  const record = readRecord(value);
  if (!record || typeof record.canRewind !== 'boolean') return null;
  return {
    canRewind: record.canRewind,
    error: typeof record.error === 'string' ? record.error : undefined,
    filesChanged: readStringArray(record.filesChanged),
    insertions: readFiniteNumber(record.insertions),
    deletions: readFiniteNumber(record.deletions),
  };
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string');
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
