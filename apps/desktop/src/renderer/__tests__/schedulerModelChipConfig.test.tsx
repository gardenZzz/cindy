// @vitest-environment jsdom

/**
 * 自动化(定时任务)模型 chip 与聊天面板对齐的几条口径:
 *  1. 注入模型级全局预设读写器 → 面板里**非选中行**也能挑推理档位(缺了它 canConfigure
 *     只对当前选中行成立,用户看到「只有已选中的模型能选档位」);
 *  2. 选中另一个模型时把该模型的预设(档位 / Fast)落进任务表单,避免行徽标显示一个档、
 *     chip 与实际 fire 用另一个档;
 *  3. Cursor 没有 Cindy provider,trigger 图标必须由 CursorMark 兜底;
 *  4. 档位能力按 (来源, 模型) 读:Pi + 自定义 API(CLIProxyAPI)在扁平 capabilities 里
 *     的档位已被跨来源交集抹平,读扁平表会让这些模型永远显示「默认档」、挑不了档位。
 */

import { render } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en', resolvedLanguage: 'en' },
  }),
}));

vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

interface CapturedContentProps {
  modelMemory?: unknown;
  onModelChange: (modelId: string) => void;
}
let capturedContentProps: CapturedContentProps | null = null;

vi.mock('@/components/new-chat/ModelSelector', () => ({
  ModelSelectorContent: (props: CapturedContentProps) => {
    capturedContentProps = props;
    return <div data-testid="model-selector-content" />;
  },
  ModelIconMark: () => <span data-testid="source-icon" />,
}));

const CURSOR_MODELS = [
  { id: 'composer-2.5', displayName: 'Composer 2.5', efforts: [], defaultEffort: null },
  {
    id: 'grok-4.5',
    displayName: 'Cursor Grok 4.5',
    efforts: ['low', 'high'],
    defaultEffort: 'high',
  },
];

/**
 * Pi 的扁平 availableModels:同一个 id 也由内置来源提供时只公布跨来源交集,
 * 自定义 API 声明的档位在这里已经塌成空(main 侧 intersectPiEffortCapabilities)。
 */
const PI_FLAT_MODELS = [
  { id: 'gpt-5.5', displayName: 'GPT-5.5', efforts: [], defaultEffort: null },
];

let availableModels: unknown[] = CURSOR_MODELS;
let providers: unknown[] = [];

vi.mock('@/hooks/useAgentCapabilities', () => ({
  getCachedCapabilities: () => null,
  useAgentCapabilities: () => ({ capabilities: { availableModels } }),
}));

vi.mock('@/hooks/useProviders', () => ({
  useProviders: () => ({ providers }),
}));

import { ModelEffortChip, resolveModelChipIconKind } from '@/features/scheduler/components/ScheduleChips';
import {
  __resetForTest as resetModelMemory,
  setProviderModelEffort,
  setProviderModelFast,
} from '@/state/providerModelMemory';

beforeEach(() => {
  capturedContentProps = null;
  availableModels = CURSOR_MODELS;
  providers = [];
  resetModelMemory();
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    maker: { requestProviderModelsAutoRefresh: vi.fn(async () => ({ ok: true as const })) },
  };
});

function renderChip(overrides: {
  onChangeModel?: (v: string) => void;
  onChangeEffort?: (v: string) => void;
  onChangeFast?: (v: boolean) => void;
} = {}) {
  const onChangeModel = overrides.onChangeModel ?? vi.fn();
  const onChangeEffort = overrides.onChangeEffort ?? vi.fn();
  const onChangeFast = overrides.onChangeFast ?? vi.fn();
  const view = render(
    <ModelEffortChip
      agentKind="cursor"
      modelValue="composer-2.5"
      onChangeModel={onChangeModel}
      effortValue=""
      onChangeEffort={onChangeEffort}
      providerId=""
      onChangeProviderId={vi.fn()}
      fastMode={false}
      onChangeFast={onChangeFast}
    />,
  );
  return { view, onChangeModel, onChangeEffort, onChangeFast };
}

describe('scheduler model chip 与聊天面板对齐', () => {
  it('把模型级全局预设读写器交给下拉内容,非选中行才可配置档位', () => {
    renderChip();
    expect(capturedContentProps?.modelMemory).toBeTruthy();
  });

  it('换模型时把该模型记住的档位与 Fast 落进任务表单', () => {
    setProviderModelEffort('cursor', 'cursor', 'grok-4.5', 'low');
    setProviderModelFast('cursor', 'cursor', 'grok-4.5', true);

    const { onChangeModel, onChangeEffort, onChangeFast } = renderChip();
    capturedContentProps?.onModelChange('grok-4.5');

    expect(onChangeModel).toHaveBeenCalledWith('grok-4.5');
    expect(onChangeEffort).toHaveBeenCalledWith('low');
    expect(onChangeFast).toHaveBeenCalledWith(true);
  });

  it('目标模型不支持记住的档位时落空值(= 跟随该模型默认档,与行徽标同口径)', () => {
    setProviderModelEffort('cursor', 'cursor', 'composer-2.5', 'low');
    setProviderModelEffort('cursor', 'cursor', 'grok-4.5', 'xhigh');

    const { onChangeEffort } = renderChip();
    capturedContentProps?.onModelChange('grok-4.5');

    expect(onChangeEffort).toHaveBeenCalledWith('');
  });

  it('Pi + 自定义 API:档位读该来源的目录条目,chip 显示真实档位而不是「默认档」', () => {
    availableModels = PI_FLAT_MODELS;
    providers = [
      {
        id: 'cliproxyapi',
        name: 'CLIProxyAPI',
        source: 'user',
        connected: true,
        agents: ['pi'],
        auth: { method: 'apiKey' },
        routing: { pi: { upstream: 'http://127.0.0.1:8317/v1', authStrategy: 'api-key-header' } },
        models: {
          pi: [
            {
              id: 'gpt-5.5',
              name: 'GPT-5.5 via proxy',
              contextWindow: 200_000,
              efforts: ['low', 'high'],
              defaultEffort: 'high',
            },
          ],
        },
      },
    ];

    const view = render(
      <ModelEffortChip
        agentKind="pi"
        modelValue="gpt-5.5"
        onChangeModel={vi.fn()}
        effortValue="low"
        onChangeEffort={vi.fn()}
        providerId="cliproxyapi"
        onChangeProviderId={vi.fn()}
      />,
    );

    expect(view.getByText('GPT-5.5 · effortLevels.low')).toBeTruthy();
  });

  it('trigger 图标:Cursor 无来源时用 CursorMark 兜底,其它 agent 保持无图标', () => {
    expect(
      resolveModelChipIconKind({ followingSession: false, activeSourceId: null, agentKind: 'cursor' }),
    ).toBe('cursor');
    expect(
      resolveModelChipIconKind({ followingSession: false, activeSourceId: null, agentKind: 'codex' }),
    ).toBe('none');
    expect(
      resolveModelChipIconKind({ followingSession: false, activeSourceId: 'xd', agentKind: 'cursor' }),
    ).toBe('source');
    // 跟随会话(未显式选模型)不显示身份图标 —— 那时没有"当前模型"可言。
    expect(
      resolveModelChipIconKind({ followingSession: true, activeSourceId: 'xd', agentKind: 'codex' }),
    ).toBe('none');
  });
});
