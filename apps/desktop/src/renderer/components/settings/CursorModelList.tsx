/**
 * CursorModelList -- Cursor 详情右栏的「模型清单 + 显示开关」精简列表。
 *
 * spec #21 / #26:Cursor **不是** model-providers 目录里的可路由供应商(ADR 0001),
 * 因此这里**不复用** `UnifiedModelList` -- 后者绑死 `ProviderView`、停用轴(「⋯」菜单 +
 * 已停用分区)、分歧 chip 与分别调整模式,Cursor 一项都用不上;复用就得合成一个只在
 * UI 层存在的假 `ProviderView`,反而捅穿本 spec 要守的「Cursor 不进可路由 catalog」边界。
 * 视觉与交互节奏对齐既有供应商详情,代码不共用。右栏卡片是固定高度 +
 * overflow-hidden,本列表必须自己吃掉剩余高度并 overflow-y-auto,否则
 * 31 个模型会被裁掉且滚轮无处可去(对齐 UnifiedModelList 的滚动契约)。
 *
 * 只做两件事(与真实供应商的「显示轴」语义一致):
 *   - 列出本机缓存到的全部 Cursor 模型,每行一个显示开关(「全部显示 / 全部隐藏」批量)。
 *   - Auto 永远列出且不带开关(它是目录为空时的唯一兜底)。
 *
 * 显示 override 复用现有 `modelVisibilityPrefs`,key = `cursor:cursor:${modelId}`
 * (providerId 用合成字面量 `cursor`,与设置页左栏哨兵 id / providerModelMemory 槽同字面量)。
 * 只存用户显式改过的 override,未改过的跟随默认全开。
 *
 * 刷新入口(props.onRefresh)由父组件 CursorDetail 传入(#28 接线进度 / 取消编排);
 * 本组件只负责按钮态与列表,不持有探测逻辑。
 *
 * 模型清单来源:`useAgentCapabilities('cursor')` 的 `availableModels`(maker-core seed
 * 自落盘缓存 + 探测后经 PROVIDER_CHANGED 刷新)。空目录 = 还没探过 / 探测失败,给空态
 * 而非空白;选择器仍有 Auto 兜底。
 */

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, RefreshCw } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Switch } from '@/components/ui/switch';
import { useAgentCapabilities } from '@/hooks/useAgentCapabilities';
import type { ModelDescriptor } from '@/hooks/useAgentCapabilities';
import {
  isModelEnabled,
  setManyVisibility,
  setModelVisibility,
  useModelVisibilityVersion,
} from '@/state/modelVisibilityPrefs';

/**
 * Cursor 产品的 Auto 模型 id -- 与 @cindy/maker-core 的
 * `CURSOR_PRODUCT_AUTO_MODEL_ID` 同字面量。这里就近定义而不 import,是为了让
 * renderer 对 maker-core 保持纯 `import type`(无运行时值引用),maker-core 整包
 * 不被拖进 dev 预打包图;否则 `session.ts` 顶层 `randomUUID()` 副作用会在
 * renderer 浏览器环境求值、`node:crypto` polyfill 无 randomUUID 即白屏
 * (vite.renderer.config.ts 的 .md loader 注释同源问题)。两处字面量必须保持一致,
 * maker-core 侧是权威定义(`packages/maker-core/src/agents/cursor/models.ts`)。
 */
const CURSOR_PRODUCT_AUTO_MODEL_ID = 'auto';

/** Cursor 合成 providerId -- 与 modelVisibilityPrefs 的三元组 key 复用同一字面量。 */
const CURSOR_VISIBILITY_PROVIDER_ID = 'cursor';
/** agent kind 与 providerId 同字面量(ADR 0001:Cursor 是独立 agent,无 Cindy provider)。 */
const CURSOR_AGENT_KIND = 'cursor' as const;

/**
 * Cursor 模型的厂商分组(2026-07-31 用户定稿:与正常供应商的分组版式对齐)。
 * Cursor 目录的 displayName 已是人类可读名("Cursor Grok 4.5" / "Composer 2.5" /
 * "Opus 5"),按名字前缀归类;第一方(Composer 系 + Auto 兜底)单独一组排最前,
 * 归不进任何前缀的进 other。判据是 displayName 而非 id —— id 带版本后缀,不稳定。
 */
const CURSOR_GROUP_ORDER = ['cursor', 'anthropic', 'openai', 'google', 'xai', 'domestic', 'other'] as const;
type CursorGroupKey = (typeof CURSOR_GROUP_ORDER)[number];

const CURSOR_GROUP_LABEL_KEY: Record<CursorGroupKey, string> = {
  cursor: 'settings.providers.cursor.groups.cursor',
  anthropic: 'settings.providers.cursor.groups.anthropic',
  openai: 'settings.providers.cursor.groups.openai',
  google: 'settings.providers.cursor.groups.google',
  xai: 'settings.providers.cursor.groups.xai',
  domestic: 'settings.providers.cursor.groups.domestic',
  other: 'settings.providers.cursor.groups.other',
};

function cursorGroupOf(displayName: string, isAuto: boolean): CursorGroupKey {
  if (isAuto) return 'cursor';
  const name = displayName.toLowerCase();
  if (name.includes('composer') || name.startsWith('cursor ')) return 'cursor';
  if (name.startsWith('opus') || name.startsWith('sonnet') || name.startsWith('haiku') || name.startsWith('fable') || name.includes('claude')) return 'anthropic';
  if (name.startsWith('gpt') || name.startsWith('codex') || name.startsWith('o3') || name.startsWith('o4')) return 'openai';
  if (name.startsWith('gemini')) return 'google';
  if (name.startsWith('grok')) return 'xai';
  if (name.startsWith('glm') || name.startsWith('kimi') || name.startsWith('qwen') || name.startsWith('deepseek')) return 'domestic';
  return 'other';
}

/** 刷新进行中的就地状态;由父组件驱动,本组件只渲染。 */
export interface CursorRefreshState {
  /** 进行中 -> 按钮禁用并显示进度。 */
  running: boolean;
  /** 已探数 / 总数。 */
  done: number;
  total: number;
  /** 不可用原因(未安装 / 未登录),入口为禁用态并提示;null 表示可用。 */
  unavailableReason: 'not-installed' | 'not-authenticated' | null;
}

export interface CursorModelListProps {
  /** 「刷新模型」点击;不可用 / 进行中时不会触发。 */
  onRefresh: () => void;
  /** 进行中取消;未进行中时 no-op。 */
  onCancel: () => void;
  refresh: CursorRefreshState;
}

export function CursorModelList({ onRefresh, onCancel, refresh }: CursorModelListProps) {
  const { t } = useTranslation();
  const { capabilities } = useAgentCapabilities(CURSOR_AGENT_KIND);
  // visibilityVersion 让开关变更后(设置页 / 聊天页)实时重算,即便本组件未重挂。
  const visibilityVersion = useModelVisibilityVersion();

  const models = capabilities?.availableModels ?? [];
  const autoIndex = useMemo(
    () => models.findIndex((m) => m.id === CURSOR_PRODUCT_AUTO_MODEL_ID),
    [models],
  );
  // Auto 恒在且不带开关;其余模型逐行开关。Auto 不在目录里时也合成一个兜底行。
  const rows: Array<{ model: ModelDescriptor; isAuto: boolean }> = useMemo(() => {
    if (autoIndex === -1) {
      return [{ model: { id: CURSOR_PRODUCT_AUTO_MODEL_ID, displayName: 'Auto', contextWindow: 200_000, efforts: [], defaultEffort: null }, isAuto: true }, ...models.map((m) => ({ model: m, isAuto: false }))];
    }
    return models.map((m, i) => ({ model: m, isAuto: i === autoIndex }));
    // visibilityVersion 进依赖:设置页 / 聊天页改开关后,本组件即便未重挂也重算可见态。
  }, [models, autoIndex, visibilityVersion]);

  const toggleable = rows.filter((r) => !r.isAuto);
  const allOn = toggleable.length > 0 && toggleable.every((r) => isModelEnabled(CURSOR_AGENT_KIND, CURSOR_VISIBILITY_PROVIDER_ID, r.model));
  const refreshDisabled = refresh.running || refresh.unavailableReason !== null;

  // 分组(版式对齐 UnifiedModelList:多组才出折叠头,单组平铺)。Auto 恒在 cursor 组首位。
  const groups = useMemo(() => {
    const byKey = new Map<CursorGroupKey, typeof rows>();
    for (const r of rows) {
      const key = cursorGroupOf(r.model.displayName || r.model.id, r.isAuto);
      const list = byKey.get(key) ?? [];
      list.push(r);
      byKey.set(key, list);
    }
    return CURSOR_GROUP_ORDER.filter((k) => byKey.has(k)).map((k) => ({ key: k, rows: byKey.get(k)! }));
  }, [rows]);
  const showGroupHeaders = groups.length > 1;
  const [collapsedMap, setCollapsedMap] = useState<Record<string, boolean>>({});
  // visibilityVersion 变化会重算 rows ⇒ 开关实时;折叠态只认用户点击,不持久化
  // (UnifiedModelList 持久化是按 category 跨供应商共享,Cursor 只有一页,页内 useState 够用)。

  const refreshLabel = refresh.running
    ? t('settings.providers.cursor.models.refreshing', { done: refresh.done, total: refresh.total })
    : t('settings.providers.cursor.models.refreshCta');

  const refreshHint =
    refresh.unavailableReason === 'not-installed'
      ? t('settings.providers.cursor.models.refreshUnavailableInstalled')
      : refresh.unavailableReason === 'not-authenticated'
        ? t('settings.providers.cursor.models.refreshUnavailableAuth')
        : null;

  // 与 UnifiedModelList 同规则(>=1000 → K,>=1M → M);行内上下文长度对齐正常供应商版式。
  const formatContextWindow = (tokens: number): string => {
    if (tokens >= 1_000_000) {
      const m = tokens / 1_000_000;
      return `${Number.isInteger(m) ? m : Number(m.toFixed(1))}M`;
    }
    if (tokens >= 1000) {
      const k = tokens / 1000;
      return `${Number.isInteger(k) ? k : Number(k.toFixed(0))}K`;
    }
    return String(tokens);
  };

  // 空态:缓存里只有 Auto(或连 Auto 都没有) = 还没探过 / 探测失败。
  if (toggleable.length === 0) {
    return (
      <div className="flex flex-col gap-3 px-5 py-4">
        <p className="text-13 leading-relaxed" style={{ color: 'var(--settings-section-desc)' }}>
          {t('settings.providers.cursor.models.emptyState')}
        </p>
        <div className="flex items-center gap-2.5">
          <PillButton
            label={refreshLabel}
            disabled={refreshDisabled}
            onClick={onRefresh}
            icon={
              refresh.running ? (
                <span className="animate-spin inline-flex">
                  <RefreshCw size={14} />
                </span>
              ) : null
            }
          />
          {refresh.running && (
            <PillButton
              label={t('settings.providers.cursor.models.cancelRefresh')}
              onClick={onCancel}
            />
          )}
          {refreshHint && (
            <span className="text-12" style={{ color: 'var(--text-tertiary)' }}>
              {refreshHint}
            </span>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 工具行:与 UnifiedModelList 同版式 —— 区块标题常驻左侧,刷新(图标)+ 全部开关在右;
          Cursor 单 agent,无「分别调整」。模型计数已上 DetailHeader,此处不再重复。
          工具行 shrink-0,只有下方清单滚动。 */}
      <div className="flex shrink-0 items-center gap-3 px-5 py-2.5">
        <span className="shrink-0 text-13 font-medium" style={{ color: 'var(--text-secondary)' }}>
          {t('settings.providers.models.available')}
        </span>
        {refreshHint && (
          <span className="text-12" style={{ color: 'var(--text-tertiary)' }}>
            {refreshHint}
          </span>
        )}
        <span className="min-w-0 flex-1" />
        <button
          type="button"
          onClick={refresh.running ? onCancel : onRefresh}
          disabled={refreshDisabled}
          aria-busy={refresh.running}
          aria-label={refresh.running ? t('settings.providers.cursor.models.cancelRefresh') : refreshLabel}
          title={refresh.running ? t('settings.providers.cursor.models.cancelRefresh') : refreshLabel}
          className={cn(
            'flex h-7 w-7 shrink-0 select-none items-center justify-center rounded-full transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]',
            (refresh.running || refreshDisabled) && 'cursor-not-allowed opacity-60',
          )}
          style={{ color: 'var(--text-secondary)' }}
        >
          {refresh.running ? (
            <span className="animate-spin inline-flex">
              <RefreshCw size={14} />
            </span>
          ) : (
            <RefreshCw size={14} />
          )}
        </button>
        <button
          type="button"
          onClick={() =>
            setManyVisibility(
              CURSOR_AGENT_KIND,
              CURSOR_VISIBILITY_PROVIDER_ID,
              toggleable.map((r) => r.model.id),
              !allOn,
            )
          }
          className="shrink-0 text-12 font-medium transition-opacity hover:opacity-80"
          style={{ color: 'var(--text-secondary)' }}
        >
          {t(allOn ? 'settings.providers.models.disableAll' : 'settings.providers.models.enableAll')}
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 pb-4 pt-0.5">
        {groups.map((g) => {
          const collapsed = showGroupHeaders && (collapsedMap[g.key] ?? false);
          return (
            <div key={g.key} className="flex flex-col">
              {showGroupHeaders && (
                <button
                  type="button"
                  onClick={() => setCollapsedMap((m) => ({ ...m, [g.key]: !collapsed }))}
                  aria-expanded={!collapsed}
                  className="flex items-center gap-1 self-start pb-0.5 text-left transition-opacity hover:opacity-80"
                >
                  <span
                    className="inline-flex transition-transform duration-150"
                    style={{ color: 'var(--text-tertiary)', transform: collapsed ? 'rotate(-90deg)' : 'none' }}
                  >
                    <ChevronDown size={12} />
                  </span>
                  <span
                    className="text-11 font-semibold uppercase"
                    style={{ color: 'var(--text-tertiary)', letterSpacing: '0.4px' }}
                  >
                    {t(CURSOR_GROUP_LABEL_KEY[g.key])}
                  </span>
                  <span
                    className="text-11 tabular-nums"
                    style={{ color: 'var(--text-tertiary)', opacity: 0.6 }}
                  >
                    {g.rows.length}
                  </span>
                </button>
              )}
              {!collapsed &&
                g.rows.map(({ model, isAuto }) => {
                  const enabled = isAuto || isModelEnabled(CURSOR_AGENT_KIND, CURSOR_VISIBILITY_PROVIDER_ID, model);
                  return (
                    <div
                      key={model.id}
                      className="flex items-center justify-between py-2"
                      style={{ borderBottom: '1px solid var(--settings-theme-card-border)' }}
                    >
                      <div className="flex min-w-0 flex-col">
                        <span className="truncate text-13 font-medium" style={{ color: 'var(--text-primary)' }}>
                          {model.displayName || model.id}
                          {isAuto && (
                            <span className="ml-2 text-11" style={{ color: 'var(--text-tertiary)' }}>
                              {t('settings.providers.cursor.models.autoHint')}
                            </span>
                          )}
                        </span>
                        {model.efforts && model.efforts.length > 0 && (
                          <span className="truncate text-11" style={{ color: 'var(--text-tertiary)' }}>
                            {t('settings.providers.cursor.models.effortHint', { count: model.efforts.length })}
                          </span>
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        {model.contextWindow > 0 && (
                          <span className="text-12 tabular-nums" style={{ color: 'var(--text-tertiary)' }}>
                            {formatContextWindow(model.contextWindow)}
                          </span>
                        )}
                        {isAuto ? (
                          <span className="text-11" style={{ color: 'var(--text-tertiary)' }}>
                            {t('settings.providers.cursor.models.autoAlwaysOn')}
                          </span>
                        ) : (
                          <Switch
                            checked={enabled}
                            onCheckedChange={(v) =>
                              setModelVisibility(CURSOR_AGENT_KIND, CURSOR_VISIBILITY_PROVIDER_ID, model.id, v)
                            }
                            aria-label={model.displayName || model.id}
                          />
                        )}
                      </div>
                    </div>
                  );
                })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PillButton({
  label,
  onClick,
  disabled,
  icon,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  icon?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-full px-[14px] text-13 font-medium transition-colors',
        'border',
        disabled && 'cursor-not-allowed opacity-60',
      )}
      style={{
        backgroundColor: 'var(--settings-btn-secondary-bg)',
        borderColor: 'var(--settings-btn-secondary-border)',
        color: 'var(--settings-btn-secondary-text)',
      }}
    >
      {icon}
      {label}
    </button>
  );
}
