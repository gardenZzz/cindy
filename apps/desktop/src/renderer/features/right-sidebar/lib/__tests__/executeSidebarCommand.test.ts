import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../store', () => ({
  ensureHydrated: vi.fn(async () => undefined),
  addOrFocusSingletonTab: vi.fn(async () => undefined),
}));
vi.mock('../openInSidebarBrowser', () => ({
  openUrlInSidebarBrowser: vi.fn(async () => undefined),
}));
vi.mock('../openInSidebarFileBrowser', () => ({
  openDirInSidebarFileBrowser: vi.fn(async () => undefined),
  openExternalFileInSidebarFileBrowser: vi.fn(async () => undefined),
  openFileInSidebarFileBrowser: vi.fn(async () => undefined),
}));
vi.mock('../openSubagentsTab', () => ({
  openSubagentsTab: vi.fn(async () => undefined),
}));
vi.mock('../../plugins/orca-workers/actions', () => ({
  ensureOrcaWorkersTab: vi.fn(async () => undefined),
  closeOrcaWorkersTabAfterTeamEnd: vi.fn(async () => undefined),
}));

import { addOrFocusSingletonTab, ensureHydrated } from '../../store';
import {
  closeOrcaWorkersTabAfterTeamEnd,
  ensureOrcaWorkersTab,
} from '../../plugins/orca-workers/actions';
import { enqueueSidebarCommand, executeSidebarCommand } from '../executeSidebarCommand';
import {
  openDirInSidebarFileBrowser,
  openExternalFileInSidebarFileBrowser,
  openFileInSidebarFileBrowser,
} from '../openInSidebarFileBrowser';
import { openUrlInSidebarBrowser } from '../openInSidebarBrowser';
import { openSubagentsTab } from '../openSubagentsTab';

describe('executeSidebarCommand', () => {
  beforeEach(() => vi.clearAllMocks());

  it('dispatches every command kind to the current renderer host implementation', async () => {
    const searchJump = {
      kind: 'conversation-search' as const,
      sessionId: 'worker-1',
      messageId: 'message-1',
      messageClientId: 'message-1',
    };
    await executeSidebarCommand({ type: 'open-terminal', sessionId: 's1' });
    await executeSidebarCommand({
      type: 'open-web-browser',
      sessionId: 's1',
      url: 'https://example.com/',
    });
    await executeSidebarCommand({
      type: 'open-file-browser',
      sessionId: 's1',
      relPath: 'src',
      targetKind: 'directory',
    });
    await executeSidebarCommand({
      type: 'open-file-browser',
      sessionId: 's1',
      relPath: 'src/App.tsx',
      targetKind: 'file',
    });
    await executeSidebarCommand({
      type: 'open-file-browser',
      sessionId: 's1',
      absPath: 'C:\\tmp\\note.md',
      targetKind: 'external-file',
    });
    await executeSidebarCommand({
      type: 'ensure-orca-workers-tab',
      sessionId: 's1',
      focusWorkerSessionId: 'worker-1',
      searchJump,
      focusTab: false,
    });
    await executeSidebarCommand({ type: 'close-orca-workers-tab', sessionId: 's1' });
    await executeSidebarCommand({
      type: 'open-subagents-tab',
      sessionId: 's1',
      focusRunId: 'shared-native-id',
      focusProvider: 'codex',
      focusTab: true,
      revealSidebar: true,
    });

    expect(ensureHydrated).toHaveBeenCalledWith('s1');
    expect(addOrFocusSingletonTab).toHaveBeenCalledWith('s1', 'terminal');
    expect(openUrlInSidebarBrowser).toHaveBeenCalledWith('s1', 'https://example.com/');
    expect(openDirInSidebarFileBrowser).toHaveBeenCalledWith('s1', 'src');
    expect(openFileInSidebarFileBrowser).toHaveBeenCalledWith('s1', 'src/App.tsx');
    expect(openExternalFileInSidebarFileBrowser).toHaveBeenCalledWith('s1', 'C:\\tmp\\note.md');
    expect(ensureOrcaWorkersTab).toHaveBeenCalledWith('s1', {
      focusWorkerSessionId: 'worker-1',
      searchJump,
      focusTab: false,
    });
    expect(closeOrcaWorkersTabAfterTeamEnd).toHaveBeenCalledWith('s1');
    expect(openSubagentsTab).toHaveBeenCalledWith('s1', {
      focusRunId: 'shared-native-id',
      focusProvider: 'codex',
      focusTab: true,
      revealSidebar: true,
      userInitiated: false,
    });
  });

  it('enqueueSidebarCommand 串行执行:后入命令等前一条完成后再开始(Codex P2)', async () => {
    const order: string[] = [];
    const close = closeOrcaWorkersTabAfterTeamEnd as ReturnType<typeof vi.fn>;
    const ensure = ensureOrcaWorkersTab as ReturnType<typeof vi.fn>;
    close.mockImplementation(async () => {
      order.push('close-start');
      await new Promise((r) => setTimeout(r, 10));
      order.push('close-end');
    });
    ensure.mockImplementation(async () => {
      order.push('ensure-start');
    });

    const p1 = enqueueSidebarCommand({ type: 'close-orca-workers-tab', sessionId: 's1' });
    const p2 = enqueueSidebarCommand({
      type: 'ensure-orca-workers-tab',
      sessionId: 's1',
      focusTab: false,
    });

    await Promise.all([p1, p2]);
    // 严格串行:ensure 必须在 close 完成后才开始,不能交错
    expect(order).toEqual(['close-start', 'close-end', 'ensure-start']);
  });
});
