/**
 * Cursor ACP extension method mappers — unit tests (no real cursor-agent).
 */

import { describe, expect, it } from 'vitest';

import {
  askQuestionResponseFromDecision,
  createPlanResponseFromDecision,
  CURSOR_TODOS_TOOL_USE_ID,
  cursorGenerateImageAcceptedResponse,
  cursorGenerateImageToEvents,
  cursorTaskAcceptedResponse,
  cursorTaskStableId,
  cursorTaskToEvents,
  formatCreatePlanReviewText,
  inferCursorTaskStatus,
  isCursorTaskTerminalStatus,
  MAX_CURSOR_GENERATE_IMAGE_DATA_CHARS,
  mergeCursorTodos,
  parseAskQuestionParams,
  parseCreatePlanParams,
  parseCursorGenerateImageParams,
  parseCursorTaskParams,
  parseUpdateTodosParams,
  preflightCursorGenerateImage,
  stopCursorTaskEvents,
  toAskUserQuestionRequest,
  todosToUpdatePlanEvents,
  toPlanReviewRequest,
  updateTodosAcceptedResponse,
} from './extensions.js';

describe('cursor ask_question mapping', () => {
  const params = parseAskQuestionParams({
    toolCallId: 'call_q',
    title: 'Need input',
    questions: [
      {
        id: 'q1',
        prompt: 'Which mode?',
        options: [
          { id: 'agent', label: 'Agent' },
          { id: 'plan', label: 'Plan' },
        ],
        allowMultiple: false,
      },
      {
        id: 'q2',
        prompt: 'Pick tests',
        options: [
          { id: 'unit', label: 'Unit' },
          { id: 'e2e', label: 'E2E' },
        ],
        allowMultiple: true,
      },
    ],
  })!;

  it('parses params and maps to ask_user_question InteractionRequest', () => {
    expect(params.questions).toHaveLength(2);
    const req = toAskUserQuestionRequest('req-1', params);
    expect(req).toEqual({
      kind: 'ask_user_question',
      requestId: 'req-1',
      questions: [
        {
          question: 'Which mode?',
          header: 'Need input',
          options: [{ label: 'Agent' }, { label: 'Plan' }],
          multiSelect: false,
        },
        {
          question: 'Pick tests',
          header: 'Need input',
          options: [{ label: 'Unit' }, { label: 'E2E' }],
          multiSelect: true,
        },
      ],
    });
  });

  it('maps Cindy answers (by prompt / multiSelect JSON) back to selectedOptionIds', () => {
    const response = askQuestionResponseFromDecision(
      {
        kind: 'ask_user_question',
        answers: {
          'Which mode?': 'Plan',
          'Pick tests': JSON.stringify(['Unit', 'E2E']),
        },
      },
      params,
    );
    expect(response).toEqual({
      outcome: {
        outcome: 'answered',
        answers: [
          { questionId: 'q1', selectedOptionIds: ['plan'] },
          { questionId: 'q2', selectedOptionIds: ['unit', 'e2e'] },
        ],
      },
    });
  });

  it('maps single-select freeform text to freeformText (not empty selectedOptionIds)', () => {
    const response = askQuestionResponseFromDecision(
      {
        kind: 'ask_user_question',
        answers: { 'Which mode?': 'Use PostgreSQL' },
      },
      params,
    );
    expect(response).toEqual({
      outcome: {
        outcome: 'answered',
        answers: [
          {
            questionId: 'q1',
            selectedOptionIds: [],
            freeformText: 'Use PostgreSQL',
          },
        ],
      },
    });
  });

  it('maps multi-select mix of option labels + freeform into both fields', () => {
    const response = askQuestionResponseFromDecision(
      {
        kind: 'ask_user_question',
        answers: {
          'Pick tests': JSON.stringify(['Unit', 'Add one smoke test']),
        },
      },
      params,
    );
    expect(response).toEqual({
      outcome: {
        outcome: 'answered',
        answers: [
          {
            questionId: 'q2',
            selectedOptionIds: ['unit'],
            freeformText: 'Add one smoke test',
          },
        ],
      },
    });
  });

  it('maps no-options question freeform into freeformText', () => {
    const noOpts = parseAskQuestionParams({
      toolCallId: 'call_free',
      questions: [{ id: 'q_open', prompt: 'Any notes?', options: [] }],
    })!;
    const response = askQuestionResponseFromDecision(
      {
        kind: 'ask_user_question',
        answers: { 'Any notes?': 'Ship behind a flag' },
      },
      noOpts,
    );
    expect(response).toEqual({
      outcome: {
        outcome: 'answered',
        answers: [
          {
            questionId: 'q_open',
            selectedOptionIds: [],
            freeformText: 'Ship behind a flag',
          },
        ],
      },
    });
  });

  it('returns skipped when answers are empty', () => {
    expect(
      askQuestionResponseFromDecision({ kind: 'ask_user_question', answers: {} }, params),
    ).toEqual({ outcome: { outcome: 'skipped', reason: 'no answers' } });
  });
});

describe('cursor create_plan mapping', () => {
  it('builds plan_review text and accept/reject outcomes', () => {
    const parsed = parseCreatePlanParams({
      toolCallId: 'call_plan',
      name: 'Refactor',
      overview: 'Tighten layout',
      plan: '1. Inspect\n2. Patch',
      todos: [{ id: 't1', content: 'Inspect', status: 'pending' }],
    })!;
    expect(toPlanReviewRequest('req-plan', parsed)).toEqual({
      kind: 'plan_review',
      requestId: 'req-plan',
      plan: '1. Inspect\n2. Patch',
    });
    expect(formatCreatePlanReviewText({ ...parsed, plan: '' })).toContain('Refactor');
    expect(createPlanResponseFromDecision({ kind: 'plan_review', behavior: 'allow' })).toEqual({
      outcome: { outcome: 'accepted' },
    });
    expect(
      createPlanResponseFromDecision({
        kind: 'plan_review',
        behavior: 'deny',
        reason: 'needs more detail',
      }),
    ).toEqual({
      outcome: { outcome: 'rejected', reason: 'needs more detail' },
    });
    expect(
      createPlanResponseFromDecision({
        kind: 'plan_review',
        behavior: 'deny',
        reason: 'session_aborted',
        dismissed: true,
      }),
    ).toEqual({ outcome: { outcome: 'cancelled' } });
  });
});

describe('cursor update_todos mapping', () => {
  it('merges todos and emits update_plan tool_use for messageRender', () => {
    const first = parseUpdateTodosParams({
      toolCallId: 'call_todo',
      merge: false,
      todos: [
        { id: '1', content: 'A', status: 'completed' },
        { id: '2', content: 'B', status: 'in_progress' },
      ],
    })!;
    let todos = mergeCursorTodos([], first.todos, first.merge);
    expect(todos).toHaveLength(2);

    const second = parseUpdateTodosParams({
      toolCallId: 'call_todo2',
      merge: true,
      todos: [{ id: '2', content: 'B', status: 'completed' }, { id: '3', content: 'C', status: 'pending' }],
    })!;
    todos = mergeCursorTodos(todos, second.todos, second.merge);
    expect(todos.map((t) => t.id)).toEqual(['1', '2', '3']);
    expect(todos.find((t) => t.id === '2')?.status).toBe('completed');

    const events = todosToUpdatePlanEvents(todos);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'tool_use',
      source: 'cursor',
      data: {
        toolUseId: CURSOR_TODOS_TOOL_USE_ID,
        toolName: 'update_plan',
      },
    });
    const input = (events[0]!.data as { input: { plan: unknown[] } }).input;
    expect(input.plan).toEqual([
      { id: '1', content: 'A', status: 'completed' },
      { id: '2', content: 'B', status: 'completed' },
      { id: '3', content: 'C', status: 'pending' },
    ]);
    expect(updateTodosAcceptedResponse(todos).outcome.outcome).toBe('accepted');
  });
});

describe('cursor/task mapping', () => {
  const sampleStart = {
    toolCallId: 'call_126',
    description: 'Explore codebase',
    prompt: 'Find auth handlers',
    subagentType: 'explore',
    status: 'running',
  };

  const sampleDone = {
    toolCallId: 'call_126',
    description: 'Explore codebase',
    prompt: 'Find auth handlers',
    subagentType: 'explore',
    agentId: 'agent-9',
    durationMs: 1200,
  };

  it('parses official completion sample and maps to Task + agent_task_update', () => {
    const parsed = parseCursorTaskParams(sampleDone)!;
    expect(cursorTaskStableId(parsed)).toBe('agent-9');
    expect(inferCursorTaskStatus(parsed)).toBe('completed');
    const events = cursorTaskToEvents(parsed);
    // 首次出现就已是终态：spawn 建持久 run，紧接着 terminal 关掉它 —— 只发 spawn
    // 的话 Subagent 工作区会永远留一条 running。
    expect(events.map((e) => e.type)).toEqual([
      'tool_use',
      'agent_task_update',
      'agent_task_update',
      'tool_result_full',
      'tool_result',
    ]);
    expect(events[1]).toMatchObject({
      data: {
        subagentObservation: {
          kind: 'spawn',
          // 持久身份用 toolCallId（agentId 在 start 时常缺）；agentId 只作为对端
          // run id 与展示别名上报。
          logicalSubagentId: 'call_126',
          parentToolUseId: 'call_126',
          identityAliases: ['agent-9'],
          providerRunIds: ['agent-9'],
        },
      },
    });
    expect(events[2]).toMatchObject({
      data: { subagentObservation: { kind: 'terminal', logicalSubagentId: 'call_126' } },
    });
    expect(events[0]).toMatchObject({
      type: 'tool_use',
      data: { toolUseId: 'call_126', toolName: 'Task' },
      source: 'cursor',
    });
    expect(events[1]).toMatchObject({
      type: 'agent_task_update',
      data: {
        provider: 'cursor',
        taskId: 'agent-9',
        parentToolUseId: 'call_126',
        status: 'completed',
        title: 'Explore codebase',
        usage: { durationMs: 1200 },
      },
    });
    expect(cursorTaskAcceptedResponse(parsed).outcome).toMatchObject({
      outcome: 'completed',
      agentId: 'agent-9',
      durationMs: 1200,
    });
  });

  it('keeps stable card id across resume and skips duplicate tool_use', () => {
    const start = parseCursorTaskParams(sampleStart)!;
    expect(inferCursorTaskStatus(start)).toBe('running');
    const first = cursorTaskToEvents(start);
    expect(first[0]?.type).toBe('tool_use');
    expect(first[1]).toMatchObject({
      type: 'agent_task_update',
      data: { taskId: 'call_126', status: 'running' },
    });

    const resume = parseCursorTaskParams({
      ...sampleDone,
      agentId: 'agent-9',
      status: 'running',
      durationMs: undefined,
    })!;
    const second = cursorTaskToEvents(resume, { alreadyEmittedToolUse: true });
    expect(second.map((e) => e.type)).toEqual(['agent_task_update']);
    expect(second[0]).toMatchObject({
      data: { taskId: 'agent-9', parentToolUseId: 'call_126', status: 'running' },
    });
  });

  it('keeps one durable subagent identity across spawn → progress → terminal', () => {
    // 三段用同一个 logicalSubagentId，否则持久层会把一个子任务落成多条 run。
    // 关键点：agentId 在 start 时缺、之后才有，所以身份不能取展示用的 taskId。
    const spawn = cursorTaskToEvents(parseCursorTaskParams(sampleStart)!);
    const progress = cursorTaskToEvents(
      parseCursorTaskParams({ ...sampleDone, status: 'running', durationMs: undefined })!,
      { alreadyEmittedToolUse: true },
    );
    const terminal = cursorTaskToEvents(parseCursorTaskParams(sampleDone)!, {
      alreadyEmittedToolUse: true,
    });

    const observationOf = (events: ReturnType<typeof cursorTaskToEvents>) =>
      (events.find((e) => e.type === 'agent_task_update')?.data as {
        subagentObservation?: { kind: string; logicalSubagentId: string };
      }).subagentObservation;

    expect(observationOf(spawn)).toMatchObject({ kind: 'spawn', logicalSubagentId: 'call_126' });
    expect(observationOf(progress)).toMatchObject({
      kind: 'progress',
      logicalSubagentId: 'call_126',
    });
    expect(observationOf(terminal)).toMatchObject({
      kind: 'terminal',
      logicalSubagentId: 'call_126',
    });
    // providerRunIds 只由 spawn 上报（契约要求）。
    expect(observationOf(progress)).not.toHaveProperty('providerRunIds');
    expect(observationOf(terminal)).not.toHaveProperty('providerRunIds');
  });

  it('maps failed/stopped and rejects invalid payloads without throwing', () => {
    expect(parseCursorTaskParams({})).toBeNull();
    expect(parseCursorTaskParams(null)).toBeNull();
    const failed = parseCursorTaskParams({
      toolCallId: 't1',
      description: 'x',
      prompt: 'y',
      subagentType: { custom: 'verifier' },
      status: 'failed',
    })!;
    expect(inferCursorTaskStatus(failed)).toBe('failed');
    const events = cursorTaskToEvents(failed);
    expect(events.find((e) => e.type === 'agent_task_update')).toMatchObject({
      data: { status: 'failed', taskType: 'verifier' },
    });
    const stopped = stopCursorTaskEvents(
      new Map([['agent-9', { toolCallId: 'call_126', title: 'Explore' }]]),
      'user_abort',
    );
    expect(stopped).toEqual([
      {
        type: 'agent_task_update',
        source: 'cursor',
        data: {
          provider: 'cursor',
          taskId: 'agent-9',
          parentToolUseId: 'call_126',
          status: 'stopped',
          title: 'Explore',
          summary: 'user_abort',
        },
      },
    ]);
  });
});

describe('cursor/generate_image mapping', () => {
  it('maps filePath completion sample to image generation event', () => {
    const parsed = parseCursorGenerateImageParams({
      toolCallId: 'call_127',
      description: 'Minimal flat app icon',
      filePath: '/tmp/icon.png',
      referenceImagePaths: ['/tmp/reference.png'],
    })!;
    const events = cursorGenerateImageToEvents(parsed);
    expect(events).toEqual([
      {
        type: 'image',
        source: 'cursor',
        data: {
          kind: 'generation',
          blockId: 'call_127',
          path: '/tmp/icon.png',
          revisedPrompt: 'Minimal flat app icon',
          status: 'completed',
        },
      },
    ]);
    expect(cursorGenerateImageAcceptedResponse(parsed)).toEqual({
      outcome: { outcome: 'generated', filePath: '/tmp/icon.png' },
    });
  });

  it('accepts data URL / base64 and rejects missing media safely', () => {
    expect(parseCursorGenerateImageParams({ toolCallId: 'x' })).toMatchObject({
      toolCallId: 'x',
    });
    expect(cursorGenerateImageToEvents(parseCursorGenerateImageParams({ toolCallId: 'x' })!)).toEqual(
      [],
    );
    expect(cursorGenerateImageAcceptedResponse(parseCursorGenerateImageParams({ toolCallId: 'x' })!)).toEqual({
      outcome: { outcome: 'rejected', reason: 'missing filePath/imageData' },
    });

    const withData = parseCursorGenerateImageParams({
      toolCallId: 'img1',
      description: 'd',
      imageData: 'AAAA',
    })!;
    expect(cursorGenerateImageToEvents(withData)[0]).toMatchObject({
      data: { url: 'data:image/png;base64,AAAA', blockId: 'img1' },
    });
    expect(parseCursorGenerateImageParams(null)).toBeNull();
  });

  it('preflight rejects outside paths and overlong imageData', () => {
    const roots = ['/Users/me/project'];
    expect(
      preflightCursorGenerateImage(
        parseCursorGenerateImageParams({
          toolCallId: 'a',
          filePath: '/Users/me/private.png',
        })!,
        { allowedRoots: roots },
      ),
    ).toBe('filePath outside allowed directories');
    expect(
      preflightCursorGenerateImage(
        parseCursorGenerateImageParams({
          toolCallId: 'b',
          filePath: '/Users/me/project/out.png',
        })!,
        { allowedRoots: roots },
      ),
    ).toBeNull();
    expect(
      preflightCursorGenerateImage(
        parseCursorGenerateImageParams({
          toolCallId: 'c',
          imageData: 'A'.repeat(MAX_CURSOR_GENERATE_IMAGE_DATA_CHARS + 1),
        })!,
        { allowedRoots: roots },
      ),
    ).toBe('imageData exceeds size limit');
    expect(isCursorTaskTerminalStatus('completed')).toBe(true);
    expect(isCursorTaskTerminalStatus('running')).toBe(false);
  });
});
