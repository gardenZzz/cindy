/**
 * CursorModelList -- Cursor 详情右栏的「模型清单 + 显示开关」精简列表。
 *
 * spec #21 / #26:Cursor **不是** model-providers 目录里的可路由供应商(ADR 0001),
 * 因此这里**不复用** `UnifiedModelList` -- 后者绑死 `ProviderView`、停用轴(「⋯」菜单 +
 * 已停用分区)、分歧 chip 与分别调整模式,Cursor 一项都用不上;复用就得合成一个只在
 * UI 层存在的假 `ProviderView`,反而捅穿本 spec 要守的「Cursor 不进可路由 catalog」边界。
 * 视觉与交互节奏对齐既有供应商详情,代码不共用。
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

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw } from 'lucide-react';

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

import { CURSOR_PRODUCT_AUTO_MODEL_ID } from '@cindy/maker-core';

/** Cursor 合成 providerId -- 与 modelVisibilityPrefs 的三元组 key 复用同一字面量。 */
const CURSOR_VISIBILITY_PROVIDER_ID = 'cursor';
/** agent kind 与 providerId 同字面量(ADR 0001:Cursor 是独立 agent,无 Cindy provider)。 */
const CURSOR_AGENT_KIND = 'cursor' as const;

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
  refresh: CursorRefreshState;
}

export function CursorModelList({ onRefresh, refresh }: CursorModelListProps) {
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

  const refreshLabel = refresh.running
    ? t('settings.providers.cursor.models.refreshing', { done: refresh.done, total: refresh.total })
    : t('settings.providers.cursor.models.refreshCta');

  const refreshHint =
    refresh.unavailableReason === 'not-installed'
      ? t('settings.providers.cursor.models.refreshUnavailableInstalled')
      : refresh.unavailableReason === 'not-authenticated'
        ? t('settings.providers.cursor.models.refreshUnavailableAuth')
        : null;

  // 空态:缓存里只有 Auto(或连 Auto 都没有) = 还没探过 / 探测失败。
  if (toggleable.length === 0) {
    return (
      <div className="flex flex-col gap-3 pl-12">
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
    <div className="flex flex-col gap-3 pl-12">
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
        <span className="text-12" style={{ color: 'var(--text-tertiary)' }}>
          {t('settings.providers.models.modelCount', { count: toggleable.length })}
        </span>
        {refreshHint && (
          <span className="text-12" style={{ color: 'var(--text-tertiary)' }}>
            {refreshHint}
          </span>
        )}
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={allOn}
          onClick={() =>
            setManyVisibility(
              CURSOR_AGENT_KIND,
              CURSOR_VISIBILITY_PROVIDER_ID,
              toggleable.map((r) => r.model.id),
              true,
            )
          }
          className={cn(
            'h-7 rounded-full px-3 text-12 font-medium transition-colors',
            allOn && 'cursor-not-allowed opacity-50',
          )}
          style={{
            backgroundColor: 'var(--settings-btn-secondary-bg)',
            color: 'var(--settings-btn-secondary-text)',
          }}
        >
          {t('settings.providers.models.enableAll')}
        </button>
        <button
          type="button"
          disabled={!allOn}
          onClick={() =>
            setManyVisibility(
              CURSOR_AGENT_KIND,
              CURSOR_VISIBILITY_PROVIDER_ID,
              toggleable.map((r) => r.model.id),
              false,
            )
          }
          className={cn(
            'h-7 rounded-full px-3 text-12 font-medium transition-colors',
            !allOn && 'cursor-not-allowed opacity-50',
          )}
          style={{
            backgroundColor: 'var(--settings-btn-secondary-bg)',
            color: 'var(--settings-btn-secondary-text)',
          }}
        >
          {t('settings.providers.models.disableAll')}
        </button>
      </div>

      <ul className="flex flex-col">
        {rows.map(({ model, isAuto }) => {
          const enabled = isAuto || isModelEnabled(CURSOR_AGENT_KIND, CURSOR_VISIBILITY_PROVIDER_ID, model);
          return (
            <li
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
            </li>
          );
        })}
      </ul>
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
