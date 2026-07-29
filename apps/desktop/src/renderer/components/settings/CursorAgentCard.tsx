/**
 * CursorAgentCard —— 设置 → 模型供应商区底部的 Cursor 本机安装状态。
 *
 * 只负责「装了没」：已装显示中性已安装态；未装显示官方安装引导。
 * 安装命令必须经确认对话框后才 IPC 执行，绝不自动触发。
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw } from 'lucide-react';

import { cn } from '@/lib/utils';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { toast } from '@/lib/toast';
import { extractIpcError } from '@/utils/ipcError';

/** 与 main 侧 CURSOR_AGENT_INSTALL_COMMAND 展示口径一致（确认框文案插值用）。 */
const CURSOR_INSTALL_COMMAND_DISPLAY = 'curl -fsSL https://cursor.com/install | bash';

type ProbeState = { kind: 'loading' } | { kind: 'installed' } | { kind: 'missing' };

export function CursorAgentCard() {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const [probe, setProbe] = useState<ProbeState>({ kind: 'loading' });
  const [installing, setInstalling] = useState(false);
  const platform = window.electronAPI.platform;
  const installSupported = platform === 'darwin' || platform === 'linux';

  const refresh = useCallback(async () => {
    setProbe({ kind: 'loading' });
    try {
      const status = await window.electronAPI.maker.agent.getCursorBinaryStatus();
      setProbe(status.installed ? { kind: 'installed' } : { kind: 'missing' });
    } catch {
      // 探测失败按未安装降级展示引导，不弹全局错误（Cursor 可选）。
      setProbe({ kind: 'missing' });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleInstall = useCallback(async () => {
    if (installing) return;
    if (!installSupported) {
      toast.error(t('settings.providers.cursor.unsupportedPlatform'));
      return;
    }
    const ok = await confirm({
      title: t('settings.providers.cursor.confirmTitle'),
      description: t('settings.providers.cursor.confirmDescription', {
        command: CURSOR_INSTALL_COMMAND_DISPLAY,
      }),
      confirmText: t('settings.providers.cursor.confirmInstall'),
      cancelText: t('settings.providers.cursor.confirmCancel'),
      autoFocusConfirm: false,
    });
    if (!ok) return;

    setInstalling(true);
    try {
      const result = await window.electronAPI.maker.agent.installCursorAgent();
      if (result.installed) {
        setProbe({ kind: 'installed' });
        toast.success(t('settings.providers.cursor.installSuccess'));
      } else {
        setProbe({ kind: 'missing' });
        toast.error(t('settings.providers.cursor.installNotDetected'));
      }
    } catch (err) {
      const ipc = extractIpcError(err);
      if (ipc?.code === 'UNSUPPORTED_CAPABILITY') {
        toast.error(t('settings.providers.cursor.unsupportedPlatform'));
      } else {
        toast.error(t('settings.providers.cursor.installFailed'));
      }
      setProbe({ kind: 'missing' });
    } finally {
      setInstalling(false);
    }
  }, [confirm, installSupported, installing, t]);

  return (
    <div
      className={cn(
        'flex flex-col gap-3 rounded-xl px-[18px] py-4',
        'bg-[var(--settings-theme-card-bg)]',
        'border border-[var(--settings-theme-card-border)]',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-14 font-medium text-[var(--settings-section-title)]">
            {t('settings.providers.cursor.title')}
          </span>
          <span className="text-13 leading-relaxed text-[var(--settings-section-desc)]">
            {probe.kind === 'installed'
              ? t('settings.providers.cursor.installedDescription')
              : t('settings.providers.cursor.missingDescription')}
          </span>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={probe.kind === 'loading' || installing}
          aria-label={t('settings.providers.cursor.refreshAria')}
          className={cn(
            'flex h-8 w-8 shrink-0 items-center justify-center rounded-full',
            'text-[var(--settings-section-desc)]',
            'hover:bg-[var(--surface-hover)]',
            'disabled:opacity-50',
          )}
        >
          <RefreshCw
            size={14}
            className={probe.kind === 'loading' || installing ? 'animate-spin' : undefined}
          />
        </button>
      </div>

      {probe.kind === 'installed' ? (
        <span
          className="flex h-[22px] w-fit items-center rounded-full px-2.5 text-11 font-medium"
          style={{
            backgroundColor: 'var(--settings-btn-secondary-bg)',
            color: 'var(--settings-section-desc)',
          }}
        >
          {t('settings.providers.cursor.installedPill')}
        </span>
      ) : probe.kind !== 'loading' ? (
        <div className="flex flex-col gap-2">
          {!installSupported ? (
            <span className="text-12 leading-relaxed text-[var(--text-tertiary)]">
              {t('settings.providers.cursor.unsupportedPlatform')}
            </span>
          ) : (
            <>
              <code
                className={cn(
                  'block overflow-x-auto rounded-lg px-3 py-2',
                  'border border-[var(--settings-theme-card-border)]',
                  'bg-[var(--surface-chip)]',
                  'font-mono text-12 text-[var(--text-secondary)]',
                )}
              >
                {CURSOR_INSTALL_COMMAND_DISPLAY}
              </code>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void handleInstall()}
                  disabled={installing}
                  className={cn(
                    'flex h-9 items-center justify-center rounded-full px-6 text-13 font-medium',
                    'transition-opacity hover:opacity-90 disabled:opacity-50',
                  )}
                  style={{
                    backgroundColor: 'var(--settings-btn-secondary-bg)',
                    color: 'var(--text-primary)',
                    border: '1px solid var(--settings-btn-secondary-border)',
                  }}
                >
                  {installing
                    ? t('settings.providers.cursor.installing')
                    : t('settings.providers.cursor.installCta')}
                </button>
                <span className="text-12 text-[var(--text-tertiary)]">
                  {t('settings.providers.cursor.optionalHint')}
                </span>
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
