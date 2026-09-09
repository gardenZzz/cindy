/**
 * CursorModelList -- Cursor 详情右栏的「模型清单 + 显示开关」精简列表。
 *
 * spec #21 / #26:Cursor **不是** model-providers 目录里的可路由供应商(ADR 0001),
 * 因此这里**不复用** `UnifiedModelList` -- 后者绑死 `ProviderView`、停用轴(「⋯」菜单 +
 * 已停用分区)、分歧 chip 与分别调整模式,Cursor 一项都用不上;复用就得合成一个只在
 * UI 层存在的假 `ProviderView`,反而捅穿本 spec 要守的「Cursor 不进可路由 catalog」边界。
 * 但**版式必须与第三方自定义端点一致**:工具行走共用的 `ModelListToolbar`,行/分组的
 * 间距、logo、hover 与滚动契约照抄 UnifiedModelList —— 分叉过一次就再也对不齐。
 * 右栏卡片是固定高度 + overflow-hidden,本列表必须自己吃掉剩余高度并 overflow-y-auto,
 * 否则 31 个模型会被裁掉且滚轮无处可去。
 *
 * 只做两件事(与真实供应商的「显示轴」语义一致):
 *   - 列出本机缓存到的全部 Cursor 模型,每行一个显示开关(「管理」菜单批量)。
 *   - Auto 永远列出且不带开关(它是目录为空时的唯一兜底),因此也不计入「已选 N 个」。
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
import { Spinner } from '@/components/ui/spinner';
import { DropdownMenuItem, DropdownMenuLabel } from '@/components/ui/dropdown-menu';
import { CursorMark } from '@/components/icons/CursorMark';
import { ProviderLogoMark } from '@/components/icons/ProviderLogoMark';
import { modelBrand } from '@/lib/modelDisplayNames';
import { useAgentCapabilities } from '@/hooks/useAgentCapabilities';
import type { ModelDescriptor } from '@/hooks/useAgentCapabilities';
import {
  isModelEnabled,
  resetModelVisibilities,
  setManyVisibility,
  setModelVisibility,
  useModelVisibilityVersion,
} from '@/state/modelVisibilityPrefs';
import { ModelListToolbar } from './ModelListToolbar';

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

/** 与 UnifiedModelList 同规则(>=1000 → K,>=1M → M)。 */
function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${Number.isInteger(m) ? m : Number(m.toFixed(1))}M`;
  }
  if (tokens >= 1000) {
    const k = tokens / 1000;
    return `${Number.isInteger(k) ? k : Number(k.toFixed(0))}K`;
  }
  return String(tokens);
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
  const [query, setQuery] = useState('');

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
  // 「已选 N 个」与 UnifiedModelList 同口径:只数有显示轴的行,Auto(常显兜底)不计。
  const selectedCount = toggleable.filter((r) =>
    isModelEnabled(CURSOR_AGENT_KIND, CURSOR_VISIBILITY_PROVIDER_ID, r.model),
  ).length;
  const allOn = toggleable.length > 0 && selectedCount === toggleable.length;
  const refreshDisabled = refresh.unavailableReason !== null;
  // 搜索只筛当前列表,不写任何开关(与 UnifiedModelList 的菜单/筛选分工一致)。
  const showSearch = toggleable.length > 8;
  const visibleRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => `${r.model.displayName} ${r.model.id}`.toLowerCase().includes(q));
  }, [rows, query]);

  // 分组(版式对齐 UnifiedModelList:多组才出折叠头,单组平铺)。Auto 恒在 cursor 组首位。
  const groups = useMemo(() => {
    const byKey = new Map<CursorGroupKey, typeof visibleRows>();
    for (const r of visibleRows) {
      const key = cursorGroupOf(r.model.displayName || r.model.id, r.isAuto);
      const list = byKey.get(key) ?? [];
      list.push(r);
      byKey.set(key, list);
    }
    return CURSOR_GROUP_ORDER.filter((k) => byKey.has(k)).map((k) => ({ key: k, rows: byKey.get(k)! }));
  }, [visibleRows]);
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

  const bulk = (action: 'show' | 'hide' | 'reset') => {
    const ids = toggleable.map((r) => r.model.id);
    if (action === 'reset') {
      resetModelVisibilities(
        CURSOR_VISIBILITY_PROVIDER_ID,
        ids.map((modelId) => ({ agent: CURSOR_AGENT_KIND, modelId })),
      );
      return;
    }
    setManyVisibility(CURSOR_AGENT_KIND, CURSOR_VISIBILITY_PROVIDER_ID, ids, action === 'show');
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
            disabled={refresh.running || refreshDisabled}
            onClick={onRefresh}
            icon={refresh.running ? <Spinner icon={RefreshCw} size={14} spinning /> : null}
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
      {/* 工具行与可路由供应商共用 ModelListToolbar;Cursor 单 agent,没有「排列」与
          用途筛选,菜单里只留批量选择。刷新进行中时同一个按钮即取消入口。 */}
      <ModelListToolbar
        selectedCount={selectedCount}
        hint={refreshHint ?? t('settings.providers.models.manage.hint')}
        refresh={{
          onClick: refresh.running ? onCancel : onRefresh,
          label: refresh.running
            ? t('settings.providers.cursor.models.cancelRefresh')
            : refreshLabel,
          busy: refresh.running,
          disabled: refreshDisabled,
        }}
        menu={
          <>
            <DropdownMenuLabel>
              {t('settings.providers.models.manage.selection')}
            </DropdownMenuLabel>
            <DropdownMenuItem disabled={allOn} onSelect={() => bulk('show')}>
              {t('settings.providers.models.manage.showAll')}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={selectedCount === 0} onSelect={() => bulk('hide')}>
              {t('settings.providers.models.manage.hideAll')}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => bulk('reset')}>
              {t('settings.providers.models.manage.reset')}
            </DropdownMenuItem>
          </>
        }
        search={showSearch ? { value: query, onChange: setQuery } : undefined}
      />

      {/* 唯一滚动区,与上方固定工具行以 1px 细线分隔。视觉左右边距 20px =
          容器 px-3 + 行 px-2(行悬停底色要包住内容),与 UnifiedModelList 同。 */}
      <div
        className="min-h-0 flex-1 overflow-y-auto border-t"
        style={{ borderColor: 'var(--settings-theme-card-border)' }}
      >
        <div className="flex flex-col gap-4 px-3 pb-4 pt-1.5">
          {groups.length === 0 ? (
            <div className="py-4 text-center text-13" style={{ color: 'var(--text-tertiary)' }}>
              {t('settings.providers.models.noResults')}
            </div>
          ) : (
            groups.map((g) => {
              // 搜索时强制展开(否则匹配项藏在折叠组里看不到);仅多组时才有折叠头。
              const collapsed =
                showGroupHeaders && !query.trim() && (collapsedMap[g.key] ?? false);
              return (
                <div key={g.key} className="flex flex-col">
                  {showGroupHeaders && (
                    <button
                      type="button"
                      onClick={() => setCollapsedMap((m) => ({ ...m, [g.key]: !collapsed }))}
                      aria-expanded={!collapsed}
                      className="flex items-center gap-1 self-start px-2 pb-0.5 text-left transition-opacity hover:opacity-80"
                    >
                      {/* chevron 用 transform 旋转(compositor-only,规则 7);折叠时 -90°。 */}
                      <span
                        className="inline-flex transition-transform duration-150"
                        style={{
                          color: 'var(--text-tertiary)',
                          transform: collapsed ? 'rotate(-90deg)' : 'none',
                        }}
                      >
                        <ChevronDown size={12} />
                      </span>
                      <span
                        className="text-11 font-medium uppercase"
                        style={{ color: 'var(--text-tertiary)', letterSpacing: '0.5px' }}
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
                      const enabled =
                        isAuto ||
                        isModelEnabled(CURSOR_AGENT_KIND, CURSOR_VISIBILITY_PROVIDER_ID, model);
                      // 行内 logo 与可路由供应商同源:按 model id 认厂牌,认不出(Composer /
                      // Auto 等 Cursor 第一方)落回 Cursor 自己的标记。
                      const logoKind = modelBrand({ id: model.id })?.logoKind;
                      return (
                        <div
                          key={model.id}
                          className="group flex items-center gap-3 rounded-lg px-2 py-[7px] transition-colors hover:bg-[var(--settings-menu-bg-hover)]"
                        >
                          <span
                            className="flex h-6 w-6 shrink-0 items-center justify-center text-[var(--text-secondary)]"
                            aria-hidden="true"
                          >
                            {logoKind ? (
                              <ProviderLogoMark
                                providerId={CURSOR_VISIBILITY_PROVIDER_ID}
                                logoKind={logoKind}
                                size={19}
                              />
                            ) : (
                              <CursorMark size={17} />
                            )}
                          </span>
                          <span
                            className="min-w-0 truncate text-14 font-medium"
                            style={{
                              color: enabled
                                ? 'var(--settings-section-title)'
                                : 'var(--text-tertiary)',
                            }}
                          >
                            {model.displayName || model.id}
                          </span>
                          {isAuto && (
                            <span
                              className="shrink-0 rounded-full bg-[var(--surface-chip)] px-2 py-0.5 text-11 font-medium"
                              style={{ color: 'var(--text-secondary)' }}
                            >
                              {t('settings.providers.cursor.models.autoHint')}
                            </span>
                          )}
                          {model.efforts && model.efforts.length > 0 && (
                            <span
                              className="shrink-0 text-11"
                              style={{ color: 'var(--text-tertiary)' }}
                            >
                              {t('settings.providers.cursor.models.effortHint', {
                                count: model.efforts.length,
                              })}
                            </span>
                          )}
                          <span className="min-w-0 flex-1" />
                          {/* 上下文长度保留在行内(UnifiedModelList 把它收进高级设置抽屉,
                              Cursor 没有那个抽屉,收起来就等于删掉这条探测结果)。 */}
                          {model.contextWindow > 0 && (
                            <span
                              className="shrink-0 text-12 tabular-nums"
                              style={{ color: 'var(--text-tertiary)' }}
                            >
                              {formatContextWindow(model.contextWindow)}
                            </span>
                          )}
                          {isAuto ? (
                            /* Auto 没有显示轴(常显兜底)⇒ 没有开关;占同宽空位保证跨行对齐,
                               与 UnifiedModelList 的能力模型行同处理。 */
                            <>
                              <span className="shrink-0 text-11" style={{ color: 'var(--text-tertiary)' }}>
                                {t('settings.providers.cursor.models.autoAlwaysOn')}
                              </span>
                              <span className="w-9 shrink-0" />
                            </>
                          ) : (
                            <Switch
                              checked={enabled}
                              onCheckedChange={(v) =>
                                setModelVisibility(
                                  CURSOR_AGENT_KIND,
                                  CURSOR_VISIBILITY_PROVIDER_ID,
                                  model.id,
                                  v,
                                )
                              }
                              aria-label={model.displayName || model.id}
                            />
                          )}
                        </div>
                      );
                    })}
                </div>
              );
            })
          )}
        </div>
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
