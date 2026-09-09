/**
 * ModelListToolbar —— 供应商详情「模型」区块的统一工具行。
 *
 * 可路由供应商(UnifiedModelList)与 ACP 供应商(CursorModelList)共用同一块头部:
 * 第一行 = 标题 + 已选计数 + 一句说明 + 刷新 + 「管理」菜单;第二行 = 筛选 + 搜索。
 * 抽出来是因为两边**必须**逐像素一致 —— Cursor 不进可路由 catalog(ADR 0001),
 * 但用户看到的是同一个「模型」区块,版式分叉一次就再也对不齐(#26 的 raw i18n key
 * 与缺失的搜索框就是这么来的)。
 *
 * 本组件只负责版式:菜单项、筛选控件与「已选」口径按调用方语义不同,全部由 props 注入。
 */

import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, RefreshCw, Search } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Spinner } from '@/components/ui/spinner';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
} from '@/components/ui/dropdown-menu';

export interface ModelListToolbarProps {
  /** 「已选 N 个」的 N;口径(是否算能力模型 / Auto 兜底行)由调用方决定。 */
  selectedCount: number;
  /** 标题下一行的说明;未连接 / 未登录等降级文案由调用方换。 */
  hint: string;
  /** 刷新入口;省略则不渲染图标按钮。 */
  refresh?: {
    onClick: () => void;
    /** 同时用作 aria-label 与 title。 */
    label: string;
    /** 只控制转圈与 aria-busy;要不要在进行中禁用由 `disabled` 单独决定
     *  —— Cursor 的刷新按钮在进行中就是取消入口,不能被 busy 顺手关掉。 */
    busy?: boolean;
    disabled?: boolean;
  };
  /** 「管理」下拉的菜单内容(DropdownMenuItem 等);省略则不渲染入口。 */
  menu?: ReactNode;
  /** 第二行左侧的筛选控件(用途 chip 组等)。 */
  filters?: ReactNode;
  /** 第二行搜索框;省略则不渲染。 */
  search?: { value: string; onChange: (next: string) => void };
}

export function ModelListToolbar({
  selectedCount,
  hint,
  refresh,
  menu,
  filters,
  search,
}: ModelListToolbarProps) {
  const { t } = useTranslation();

  return (
    // 第一行说明模型选择与管理，第二行仅筛选当前列表。排列和批量配置在菜单里
    // 明确分组，任何筛选或排列操作都不写入模型开关。
    <div className="flex shrink-0 flex-col gap-2 px-5 pb-2 pt-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-13 font-medium text-[var(--text-primary)]">
              {t('settings.providers.models.manage.title')}
            </span>
            <span className="text-11 text-[var(--text-tertiary)]">
              {t('settings.providers.models.manage.selected', { count: selectedCount })}
            </span>
          </div>
          <p className="mt-0.5 text-11 text-[var(--text-tertiary)]">{hint}</p>
        </div>
        {refresh && (
          <button
            type="button"
            onClick={refresh.onClick}
            disabled={refresh.disabled ?? false}
            aria-busy={refresh.busy}
            aria-label={refresh.label}
            title={refresh.label}
            className={cn(
              'flex h-7 w-7 shrink-0 select-none items-center justify-center rounded-full transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]',
              refresh.disabled && 'cursor-not-allowed opacity-60',
            )}
            style={{ color: 'var(--text-secondary)' }}
          >
            <Spinner icon={RefreshCw} size={14} spinning={refresh.busy ?? false} />
          </button>
        )}
        {menu && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex h-7 shrink-0 items-center gap-1 rounded-full px-2 text-12 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]"
              >
                {t('settings.providers.models.manage.menu')}
                <ChevronDown size={12} aria-hidden />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">{menu}</DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {/* 第二行只在真有筛选控件时才占位:单类型 + 模型少的来源(本机 Ollama 等)
          两个都不渲染,不留一条空行。 */}
      {(filters || search) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {filters}
          <span className="min-w-0 flex-1" />
          {search && (
            /* basis 200px 但允许收缩:窄窗口(右栏可被压到 ~270px)时先压缩搜索框,
               不让 chip 组被 overflow-hidden 裁掉(PR #1102 review)。 */
            <div
              className="flex h-8 min-w-0 basis-[200px] items-center gap-2 rounded-full px-3"
              style={{
                backgroundColor: 'var(--surface-elevated)',
                border: '1px solid var(--border-default)',
              }}
            >
              <Search size={14} className="shrink-0" style={{ color: 'var(--text-tertiary)' }} />
              <input
                type="text"
                value={search.value}
                onChange={(e) => search.onChange(e.target.value)}
                placeholder={t('settings.providers.models.search')}
                aria-label={t('settings.providers.models.search')}
                className="min-w-0 flex-1 bg-transparent text-13 outline-none placeholder:text-[var(--text-placeholder)]"
                style={{ color: 'var(--settings-section-title)' }}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
