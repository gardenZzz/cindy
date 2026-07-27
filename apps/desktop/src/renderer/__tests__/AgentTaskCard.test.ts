// @vitest-environment jsdom

import React from 'react';
import { act, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) => {
      if (key === 'chat.agentTask.provider.claude') return 'Claude Code';
      if (key === 'chat.agentTask.provider.codex') return 'Codex';
      if (key === 'chat.agentTask.status.completed') return 'Completed';
      if (key === 'chat.agentTask.status.running') return 'Running';
      if (key === 'chat.agentTask.tokens') return `${vars?.count} tokens`;
      if (key === 'chat.agentTask.toolUses') return `${vars?.count} tool uses`;
      if (key === 'chat.agentTask.workflowProgressLine') {
        return `${vars?.phase} · ${vars?.done}/${vars?.total} Agent`;
      }
      if (key === 'chat.agentTask.workflowProgressCount') {
        return `${vars?.done}/${vars?.total} Agent`;
      }
      return key;
    },
  }),
}));

vi.mock('@/hooks/useExpandedBlockMemory', () => ({
  useExpandedBlockMemory: () => ({
    expanded: true,
    setExpanded: vi.fn(),
  }),
}));

const { openBackgroundTasksTabMock } = vi.hoisted(() => ({
  openBackgroundTasksTabMock: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/features/right-sidebar/lib/openBackgroundTasksTab', () => ({
  openBackgroundTasksTab: openBackgroundTasksTabMock,
}));

import { AgentTaskCard } from '@/components/chat/AgentTaskCard';

describe('AgentTaskCard', () => {
  it('renders the full expanded task result instead of truncating it', () => {
    const tail = 'TAIL_MARKER_KEPT_VISIBLE';
    const longResult = `Summary start\n\n${'x'.repeat(500)}\n${tail}`;

    const { container } = render(
      React.createElement(AgentTaskCard, {
        result: longResult,
        update: {
          provider: 'claude-code',
          taskId: 'task-1',
          status: 'completed',
          title: 'Inspect files',
        },
      }),
    );

    expect(container.textContent).toContain(tail);
    expect(container.textContent).toContain('Summary start');
  });

  it('prefers the paired tool result over task update summaries', () => {
    const { container } = render(
      React.createElement(AgentTaskCard, {
        result: 'Final answer from the Agent tool_result',
        update: {
          provider: 'claude-code',
          taskId: 'task-1',
          status: 'completed',
          title: 'Inspect files',
          summary: 'Task notification summary only',
        },
      }),
    );

    expect(container.textContent).toContain('Final answer from the Agent tool_result');
    expect(container.textContent).not.toContain('Task notification summary only');
  });

  // subagent-model-chip --------------------------------------------------------
  const modelChip = (container: HTMLElement) =>
    container.querySelector('[data-agent-task-model-chip="true"]');

  it('renders the subagent model chip from update.model (live)', () => {
    const { container } = render(
      React.createElement(AgentTaskCard, {
        update: {
          provider: 'claude-code',
          taskId: 'task-1',
          status: 'running',
          title: 'Explore the codebase',
          model: 'claude-haiku-4-5-20251001',
        },
      }),
    );
    expect(modelChip(container)?.textContent).toBe('Haiku 4.5');
  });

  it('falls back to subagentModel prop when update is absent (history reload)', () => {
    const { container } = render(
      React.createElement(AgentTaskCard, {
        toolCall: {
          clientId: 'c1',
          role: 'tool_use',
          content: '',
          toolName: 'Agent',
          toolUseId: 'toolu_AGENT',
        },
        result: 'done',
        subagentModel: 'claude-haiku-4-5-20251001',
      }),
    );
    expect(modelChip(container)?.textContent).toBe('Haiku 4.5');
  });

  it('renders no chip when neither update.model nor subagentModel is present', () => {
    const { container } = render(
      React.createElement(AgentTaskCard, {
        update: {
          provider: 'codex',
          taskId: 'task-1',
          status: 'running',
          title: 'Worker task',
        },
      }),
    );
    expect(modelChip(container)).toBeNull();
  });

  // bash-task-card + 停止按钮 ---------------------------------------------------
  const stopButton = (container: HTMLElement) =>
    container.querySelector<HTMLButtonElement>('[data-agent-task-stop="true"]');

  it('renders local_bash tasks as a background command with a stop button while running', async () => {
    const stopAgentTask = vi.fn().mockResolvedValue({ ok: true });
    (window as unknown as { electronAPI?: unknown }).electronAPI = {
      maker: { stopAgentTask },
    };
    try {
      const { container } = render(
        React.createElement(AgentTaskCard, {
          sessionId: 'session-1',
          update: {
            provider: 'claude-code',
            taskId: 'bash-1',
            status: 'running',
            title: 'pnpm test:unit',
            taskType: 'local_bash',
          },
        }),
      );
      expect(container.textContent).toContain('chat.agentTask.provider.shell');
      const btn = stopButton(container);
      expect(btn).not.toBeNull();
      // stop 的 finally(setStopping)在微任务里落地,await 到位避免 act 泄漏警告。
      await act(async () => {
        btn!.click();
        await Promise.resolve();
      });
      expect(stopAgentTask).toHaveBeenCalledWith('session-1', 'bash-1');
    } finally {
      delete (window as unknown as { electronAPI?: unknown }).electronAPI;
    }
  });

  it('hides the stop button for terminal tasks, codex tasks, and when sessionId is missing', () => {
    const terminal = render(
      React.createElement(AgentTaskCard, {
        sessionId: 'session-1',
        update: {
          provider: 'claude-code',
          taskId: 'bash-1',
          status: 'completed',
          taskType: 'local_bash',
        },
      }),
    );
    expect(stopButton(terminal.container)).toBeNull();

    const codex = render(
      React.createElement(AgentTaskCard, {
        sessionId: 'session-1',
        update: { provider: 'codex', taskId: 'c1', status: 'running' },
      }),
    );
    expect(stopButton(codex.container)).toBeNull();

    const noSession = render(
      React.createElement(AgentTaskCard, {
        update: {
          provider: 'claude-code',
          taskId: 'bash-1',
          status: 'running',
          taskType: 'local_bash',
        },
      }),
    );
    expect(stopButton(noSession.container)).toBeNull();
  });

  // workflow-card:整卡 = 后台任务面板入口 -------------------------------------
  const headerButton = (container: HTMLElement) =>
    container.querySelector<HTMLButtonElement>('button[aria-label="chat.agentTask.openInPanel"]');

  it('opens the background tasks panel focused on the task when a workflow card is clicked', () => {
    openBackgroundTasksTabMock.mockClear();
    const { container } = render(
      React.createElement(AgentTaskCard, {
        sessionId: 'session-1',
        update: {
          provider: 'claude-code',
          taskId: 'wf-1',
          status: 'running',
          taskType: 'local_workflow',
          workflowName: 'Release pipeline',
        },
      }),
    );
    const btn = headerButton(container);
    expect(btn).not.toBeNull();
    // workflow 卡不是展开 toggle:无 aria-expanded。
    expect(btn!.hasAttribute('aria-expanded')).toBe(false);
    act(() => {
      btn!.click();
    });
    expect(openBackgroundTasksTabMock).toHaveBeenCalledWith('session-1', { focusTaskId: 'wf-1' });
  });

  it('degrades to a no-op when sessionId or taskId is missing on a workflow card', () => {
    openBackgroundTasksTabMock.mockClear();
    const { container } = render(
      React.createElement(AgentTaskCard, {
        // sessionId 缺失 → 点击不跳转,外观不变。
        update: {
          provider: 'claude-code',
          taskId: 'wf-1',
          status: 'running',
          taskType: 'local_workflow',
        },
      }),
    );
    const btn = headerButton(container);
    expect(btn).not.toBeNull();
    act(() => {
      btn!.click();
    });
    expect(openBackgroundTasksTabMock).not.toHaveBeenCalled();
  });

  it('renders no inline expand region for workflow cards', () => {
    const { container } = render(
      React.createElement(AgentTaskCard, {
        sessionId: 'session-1',
        update: {
          provider: 'claude-code',
          taskId: 'wf-1',
          status: 'completed',
          taskType: 'local_workflow',
          workflowName: 'Release pipeline',
          description: 'WORKFLOW_DESCRIPTION_HIDDEN',
          summary: 'WORKFLOW_SUMMARY_HIDDEN',
        },
      }),
    );
    // useExpandedBlockMemory mock 恒为 expanded=true,仍不得渲染展开区内容。
    expect(container.textContent).not.toContain('WORKFLOW_DESCRIPTION_HIDDEN');
    expect(container.textContent).not.toContain('WORKFLOW_SUMMARY_HIDDEN');
    expect(container.querySelector('[aria-expanded]')).toBeNull();
  });

  const progressLine = (container: HTMLElement) =>
    container.querySelector('[data-workflow-progress-line="true"]');

  it('renders the live progress line from workflowProgress entries', () => {
    const { container } = render(
      React.createElement(AgentTaskCard, {
        sessionId: 'session-1',
        update: {
          provider: 'claude-code',
          taskId: 'wf-1',
          status: 'running',
          taskType: 'local_workflow',
          workflowProgress: [
            { type: 'workflow_phase', index: 0, title: 'Build' },
            { type: 'workflow_agent', index: 1, label: 'a', phaseTitle: 'Build', state: 'done' },
            { type: 'workflow_agent', index: 2, label: 'b', phaseTitle: 'Test', state: 'progress' },
            { type: 'workflow_agent', index: 3, label: 'c', phaseTitle: 'Test', state: 'error' },
          ],
        },
      }),
    );
    expect(progressLine(container)?.textContent).toBe('Test · 2/3 Agent');
  });

  it('falls back to counts only when no running agent carries a phaseTitle', () => {
    const { container } = render(
      React.createElement(AgentTaskCard, {
        sessionId: 'session-1',
        update: {
          provider: 'claude-code',
          taskId: 'wf-1',
          status: 'completed',
          taskType: 'local_workflow',
          workflowProgress: [
            { type: 'workflow_agent', index: 0, label: 'a', state: 'done' },
            { type: 'workflow_agent', index: 1, label: 'b', state: 'done' },
          ],
        },
      }),
    );
    expect(progressLine(container)?.textContent).toBe('2/2 Agent');
  });

  it('renders no progress line when workflowProgress is absent, and keeps non-workflow cards off the panel entry', () => {
    openBackgroundTasksTabMock.mockClear();
    const workflow = render(
      React.createElement(AgentTaskCard, {
        sessionId: 'session-1',
        update: {
          provider: 'claude-code',
          taskId: 'wf-1',
          status: 'running',
          taskType: 'local_workflow',
        },
      }),
    );
    expect(progressLine(workflow.container)).toBeNull();

    const normal = render(
      React.createElement(AgentTaskCard, {
        sessionId: 'session-1',
        update: {
          provider: 'claude-code',
          taskId: 'task-1',
          status: 'running',
          title: 'Inspect files',
        },
      }),
    );
    // 普通卡头部仍是展开 toggle,不触发面板。
    const toggleBtn = normal.container.querySelector<HTMLButtonElement>('button[aria-expanded]');
    expect(toggleBtn).not.toBeNull();
    act(() => {
      toggleBtn!.click();
    });
    expect(openBackgroundTasksTabMock).not.toHaveBeenCalled();
    expect(progressLine(normal.container)).toBeNull();
  });
});
