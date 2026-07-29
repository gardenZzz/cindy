/**
 * Cursor ACP extension method mappers — unit tests (no real cursor-agent).
 */

import { describe, expect, it } from 'vitest';

import {
  askQuestionResponseFromDecision,
  createPlanResponseFromDecision,
  CURSOR_TODOS_TOOL_USE_ID,
  formatCreatePlanReviewText,
  mergeCursorTodos,
  parseAskQuestionParams,
  parseCreatePlanParams,
  parseUpdateTodosParams,
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
