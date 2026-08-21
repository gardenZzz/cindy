/**
 * 保存时把 chip 展示的目录默认档写成显式值。
 * 不回填历史空档任务；心跳/跟随会话的空档仍表示继承。
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';

import { formToProjectConfig } from '../projectAutomationConfig';
import {
  buildScheduleInput,
  resolvePersistedScheduleEffort,
  type ScheduleFormState,
  type ScheduleModelEfforts,
} from '../scheduleFormLogic';

const GROK_46: ScheduleModelEfforts = {
  efforts: ['low', 'medium', 'high', 'xhigh'],
  defaultEffort: 'xhigh',
  known: true,
};

const GPT_HIGH: ScheduleModelEfforts = {
  efforts: ['high'],
  defaultEffort: 'high',
  known: true,
};

function makeForm(overrides: Partial<ScheduleFormState> = {}): ScheduleFormState {
  return {
    name: 'persist-default-effort',
    prompt: 'run',
    cronExpr: '0 9 * * *',
    timezone: 'Asia/Shanghai',
    recurring: true,
    manual: false,
    agentKind: 'cursor',
    model: 'grok-4.6',
    providerId: '',
    effort: '',
    fastMode: false,
    workspaceKind: 'project',
    workingDir: '/repo',
    useWorktree: false,
    targetSessionId: '',
    persistentSession: false,
    silentWhenIdle: false,
    preRunHookEnabled: false,
    preRunHookCommand: '',
    preRunHookTimeoutSec: '',
    notifyDesktop: true,
    notifyFeishu: false,
    ...overrides,
  };
}

describe('resolvePersistedScheduleEffort', () => {
  it('空档 + 已知目录默认档 → 写成该默认档（不限 grok）', () => {
    expect(resolvePersistedScheduleEffort(makeForm({ effort: '' }), GROK_46)).toBe('xhigh');
    expect(resolvePersistedScheduleEffort(
      makeForm({ model: 'gpt-5.5', agentKind: 'codex', effort: '' }),
      GPT_HIGH,
    )).toBe('high');
  });

  it('用户显式档原样保留', () => {
    expect(resolvePersistedScheduleEffort(makeForm({ effort: 'low' }), GROK_46)).toBe('low');
  });

  it('跟随会话（空 model）或心跳不写默认档', () => {
    expect(resolvePersistedScheduleEffort(makeForm({ model: '', effort: '' }), GROK_46)).toBeUndefined();
    expect(resolvePersistedScheduleEffort(
      makeForm({ targetSessionId: 'sess-1', model: 'grok-4.6', effort: '' }),
      GROK_46,
    )).toBeUndefined();
  });

  it('目录未知或脚本模式不发明默认档', () => {
    expect(resolvePersistedScheduleEffort(makeForm(), { efforts: [], defaultEffort: null, known: false }))
      .toBeUndefined();
    expect(resolvePersistedScheduleEffort(makeForm({ executionMode: 'script' }), GROK_46)).toBeUndefined();
  });
});

describe('buildScheduleInput / formToProjectConfig 保存时写入展示档', () => {
  it('fresh 任务空档写入目录 defaultEffort', () => {
    const input = buildScheduleInput(makeForm({ effort: '' }), GROK_46);
    expect(input.effort).toBe('xhigh');
  });

  it('心跳空档仍带 effort key 且值为 undefined', () => {
    const input = buildScheduleInput(
      makeForm({ targetSessionId: 'sess-1', model: 'grok-4.6', effort: '' }),
      GROK_46,
    );
    expect(Object.prototype.hasOwnProperty.call(input, 'effort')).toBe(true);
    expect(input.effort).toBeUndefined();
  });

  it('项目自动化同一口径', () => {
    expect(formToProjectConfig(makeForm({ effort: '' }), 'auto-1', GROK_46).effort).toBe('xhigh');
    expect(formToProjectConfig(makeForm({ model: '', effort: '' }), 'auto-2', GROK_46).effort).toBeUndefined();
  });
});
