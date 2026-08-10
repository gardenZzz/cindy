/**
 * 场景 B：纯本地 Cursor 会话改 effort/fast/model 后，必须写入 lastByVendor.cursor，
 * 不能再被二元映射 `!== 'codex' → 'cc'` 写进 Claude 槽。
 *
 * 复现 ChatInput.syncSessionDraftModelPrefs 本地分支的落盘路径
 * （agentKindToDraftVendor + patchVendorPrefsPreservingModelChoice）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { agentKindToDraftVendor } from '../../../../shared/agentKindDraftVendor';

class MemLocalStorage {
  private store = new Map<string, string>();
  getItem(k: string): string | null {
    return this.store.has(k) ? (this.store.get(k) as string) : null;
  }
  setItem(k: string, v: string): void {
    this.store.set(k, v);
  }
  removeItem(k: string): void {
    this.store.delete(k);
  }
  clear(): void {
    this.store.clear();
  }
}

let memStorage: MemLocalStorage;
const here = dirname(fileURLToPath(import.meta.url));

beforeEach(() => {
  memStorage = new MemLocalStorage();
  vi.stubGlobal('window', { localStorage: memStorage });
  vi.stubGlobal('localStorage', memStorage);
  vi.resetModules();
});

describe('本地 Cursor session→draft 同步（场景 B）', () => {
  it('Cursor 会话改偏好写入 cursor 槽，不污染 cc 槽（修复前二元映射会写 cc）', async () => {
    const { getDraft, patchVendorPrefsPreservingModelChoice } = await import(
      '@/state/newMakerDraft'
    );
    const ccModelBefore = getDraft().lastByVendor.cc.model;
    const cursorModelBefore = getDraft().lastByVendor.cursor.model;

    // ChatInput 本地分支：currentModelAgentKind === 'cursor'
    const vendor = agentKindToDraftVendor('cursor');
    expect(vendor).toBe('cursor');
    // 旧代码：const vendor = currentModelAgentKind === 'codex' ? 'codex' : 'cc' → 'cc'
    expect(vendor).not.toBe('cc');

    patchVendorPrefsPreservingModelChoice(vendor, {
      model: 'composer-1',
      effort: 'high',
      providerId: null,
    });

    const draft = getDraft();
    expect(draft.lastByVendor.cursor.model).toBe('composer-1');
    expect(draft.lastByVendor.cursor.effort).toBe('high');
    expect(draft.lastByVendor.cc.model).toBe(ccModelBefore);
    expect(draft.lastByVendor.cursor.model).not.toBe(cursorModelBefore);
  });

  it('ChatInput.syncSessionDraftModelPrefs 本地分支复用 agentKindToDraftVendor', () => {
    const src = readFileSync(join(here, '../ChatInput.tsx'), 'utf8');
    const start = src.indexOf('const syncSessionDraftModelPrefs');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, start + 2200);
    expect(body).toContain('agentKindToDraftVendor(currentModelAgentKind)');
    expect(body).not.toContain("currentModelAgentKind === 'codex' ? 'codex' : 'cc'");
  });
});
