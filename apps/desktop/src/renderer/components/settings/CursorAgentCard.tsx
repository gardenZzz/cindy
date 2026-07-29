/**
 * CursorAgentCard —— 设置 → 模型供应商区底部的 Cursor 本机安装 + 登录态。
 *
 * 未装：官方安装引导（确认后才 IPC 执行）。
 * 已装：展示 cursor-agent 登录状态，提供登录 / 登出。
 * 登录用 NO_OPEN_BROWSER 取 URL，由用户自愿「打开」或「复制」——不强制拉起浏览器。
 * 凭证只由 cursor CLI / Keychain 管理，本组件不读写任何凭证材料。
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

const CURSOR_AGENT_KIND = 'cursor' as const;

type ProbeState = { kind: 'loading' } | { kind: 'installed' } | { kind: 'missing' };

type AuthView =
  | { kind: 'loading' }
  | { kind: 'authenticated'; identity?: string }
  | { kind: 'unauthenticated' }
  | { kind: 'login-pending'; loginUrl: string | null };

const LOGIN_URL_RE = /https:\/\/[^\s<>"']+/i;

function extractLoginUrl(detail: string): string | null {
  const match = detail.match(LOGIN_URL_RE);
  if (!match) return null;
  return match[0].replace(/[.,;:!?)]+$/, '');
}

export function CursorAgentCard() {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const [probe, setProbe] = useState<ProbeState>({ kind: 'loading' });
  const [auth, setAuth] = useState<AuthView>({ kind: 'loading' });
  const [installing, setInstalling] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const platform = window.electronAPI.platform;
  const installSupported = platform === 'darwin' || platform === 'linux';

  const refreshAuth = useCallback(async () => {
    const authApi = window.electronAPI?.maker?.auth;
    if (!authApi?.getState) {
      setAuth({ kind: 'unauthenticated' });
      return;
    }
    try {
      const state = await authApi.getState(CURSOR_AGENT_KIND);
      setAuth(
        state.authenticated
          ? { kind: 'authenticated', identity: state.identity }
          : { kind: 'unauthenticated' },
      );
    } catch {
      // Agent 未注册（极少见：探测说已装但 Maker 未挂 Cursor）→ 按未登录降级。
      setAuth({ kind: 'unauthenticated' });
    }
  }, []);

  const refresh = useCallback(async () => {
    setProbe({ kind: 'loading' });
    try {
      const status = await window.electronAPI.maker.agent.getCursorBinaryStatus();
      if (status.installed) {
        setProbe({ kind: 'installed' });
        await refreshAuth();
      } else {
        setProbe({ kind: 'missing' });
        setAuth({ kind: 'loading' });
      }
    } catch {
      // 探测失败按未安装降级展示引导，不弹全局错误（Cursor 可选）。
      setProbe({ kind: 'missing' });
    }
  }, [refreshAuth]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const authApi = window.electronAPI?.maker?.auth;
    if (!authApi?.onStateChanged || !authApi?.onLoginProgress) return;
    const offState = authApi.onStateChanged((payload) => {
      if (payload.agentKind !== CURSOR_AGENT_KIND) return;
      setAuth(
        payload.authenticated
          ? { kind: 'authenticated', identity: payload.identity }
          : { kind: 'unauthenticated' },
      );
      setAuthBusy(false);
    });
    const offProgress = authApi.onLoginProgress((progress) => {
      if (progress.agentKind !== CURSOR_AGENT_KIND) return;
      const detail =
        typeof (progress as { detail?: unknown }).detail === 'string'
          ? (progress as { detail: string }).detail
          : typeof (progress as { phase?: unknown }).phase === 'string'
            ? (progress as { phase: string }).phase
            : '';
      const url = extractLoginUrl(detail);
      setAuth((prev) => ({
        kind: 'login-pending',
        loginUrl: url ?? (prev.kind === 'login-pending' ? prev.loginUrl : null),
      }));
    });
    return () => {
      offState();
      offProgress();
    };
  }, []);

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
        await refreshAuth();
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
  }, [confirm, installSupported, installing, refreshAuth, t]);

  const handleLogin = useCallback(async () => {
    if (authBusy) return;
    setAuthBusy(true);
    setAuth({ kind: 'login-pending', loginUrl: null });
    try {
      const state = await window.electronAPI.maker.auth.triggerLogin(CURSOR_AGENT_KIND);
      if (state.authenticated) {
        setAuth({ kind: 'authenticated', identity: state.identity });
        toast.success(t('settings.providers.cursor.loginSuccess'));
      } else {
        setAuth({ kind: 'unauthenticated' });
        if (state.errorReason !== 'login_cancelled') {
          toast.error(t('settings.providers.cursor.loginFailed'));
        }
      }
    } catch {
      setAuth({ kind: 'unauthenticated' });
      toast.error(t('settings.providers.cursor.loginFailed'));
    } finally {
      setAuthBusy(false);
    }
  }, [authBusy, t]);

  const handleCancelLogin = useCallback(async () => {
    try {
      await window.electronAPI.maker.auth.cancelLogin(CURSOR_AGENT_KIND);
    } catch {
      /* ignore */
    }
    setAuthBusy(false);
    setAuth({ kind: 'unauthenticated' });
  }, []);

  const handleLogout = useCallback(async () => {
    const ok = await confirm({
      title: t('settings.providers.cursor.logoutConfirmTitle'),
      description: t('settings.providers.cursor.logoutConfirmDescription'),
      confirmText: t('settings.providers.cursor.logoutConfirm'),
      cancelText: t('settings.providers.cursor.confirmCancel'),
    });
    if (!ok) return;
    setAuthBusy(true);
    try {
      await window.electronAPI.maker.auth.logout(CURSOR_AGENT_KIND);
      setAuth({ kind: 'unauthenticated' });
      toast.success(t('settings.providers.cursor.logoutSuccess'));
    } catch {
      toast.error(t('settings.providers.cursor.logoutFailed'));
    } finally {
      setAuthBusy(false);
    }
  }, [confirm, t]);

  const loginUrl = auth.kind === 'login-pending' ? auth.loginUrl : null;

  const handleCopyLoginUrl = useCallback(async () => {
    if (!loginUrl) return;
    try {
      await navigator.clipboard.writeText(loginUrl);
      toast.success(t('settings.providers.cursor.loginUrlCopied'));
    } catch {
      toast.error(t('settings.providers.cursor.loginUrlCopyFailed'));
    }
  }, [loginUrl, t]);

  const handleOpenLoginUrl = useCallback(() => {
    if (!loginUrl) return;
    void window.electronAPI.openExternal(loginUrl);
  }, [loginUrl]);

  const installedDescription =
    auth.kind === 'authenticated'
      ? t('settings.providers.cursor.loggedInDescription', {
          identity: auth.identity ?? t('settings.providers.cursor.loggedInUnknown'),
        })
      : auth.kind === 'login-pending'
        ? t('settings.providers.cursor.loginPendingDescription')
        : t('settings.providers.cursor.installedSignedOutDescription');

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
              ? installedDescription
              : t('settings.providers.cursor.missingDescription')}
          </span>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={probe.kind === 'loading' || installing || authBusy}
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
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className="flex h-[22px] w-fit items-center rounded-full px-2.5 text-11 font-medium"
              style={{
                backgroundColor: 'var(--settings-btn-secondary-bg)',
                color: 'var(--settings-section-desc)',
              }}
            >
              {t('settings.providers.cursor.installedPill')}
            </span>
            {auth.kind === 'authenticated' ? (
              <span
                className="flex h-[22px] w-fit items-center rounded-full px-2.5 text-11 font-medium"
                style={{
                  backgroundColor: 'var(--settings-btn-secondary-bg)',
                  color: 'var(--text-primary)',
                }}
              >
                {t('settings.providers.cursor.loggedInPill')}
              </span>
            ) : auth.kind !== 'loading' ? (
              <span
                className="flex h-[22px] w-fit items-center rounded-full px-2.5 text-11 font-medium"
                style={{
                  backgroundColor: 'var(--settings-btn-secondary-bg)',
                  color: 'var(--text-tertiary)',
                }}
              >
                {t('settings.providers.cursor.signedOutPill')}
              </span>
            ) : null}
          </div>

          {auth.kind === 'login-pending' && loginUrl ? (
            <div className="flex flex-col gap-2">
              <code
                className={cn(
                  'block overflow-x-auto rounded-lg px-3 py-2',
                  'border border-[var(--settings-theme-card-border)]',
                  'bg-[var(--surface-chip)]',
                  'font-mono text-12 text-[var(--text-secondary)]',
                )}
              >
                {loginUrl}
              </code>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={handleOpenLoginUrl}
                  className={cn(
                    'flex h-9 items-center justify-center rounded-full px-4 text-13 font-medium',
                    'transition-opacity hover:opacity-90',
                  )}
                  style={{
                    backgroundColor: 'var(--settings-btn-secondary-bg)',
                    color: 'var(--text-primary)',
                    border: '1px solid var(--settings-btn-secondary-border)',
                  }}
                >
                  {t('settings.providers.cursor.openLoginUrl')}
                </button>
                <button
                  type="button"
                  onClick={() => void handleCopyLoginUrl()}
                  className={cn(
                    'flex h-9 items-center justify-center rounded-full px-4 text-13 font-medium',
                    'transition-opacity hover:opacity-90',
                  )}
                  style={{
                    backgroundColor: 'var(--settings-btn-secondary-bg)',
                    color: 'var(--text-primary)',
                    border: '1px solid var(--settings-btn-secondary-border)',
                  }}
                >
                  {t('settings.providers.cursor.copyLoginUrl')}
                </button>
                <button
                  type="button"
                  onClick={() => void handleCancelLogin()}
                  className={cn(
                    'flex h-9 items-center justify-center rounded-full px-4 text-13 font-medium',
                    'text-[var(--text-tertiary)] transition-opacity hover:opacity-90',
                  )}
                >
                  {t('settings.providers.cursor.cancelLogin')}
                </button>
              </div>
              <span className="text-12 text-[var(--text-tertiary)]">
                {t('settings.providers.cursor.loginUrlHint')}
              </span>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              {auth.kind === 'authenticated' ? (
                <button
                  type="button"
                  onClick={() => void handleLogout()}
                  disabled={authBusy}
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
                  {t('settings.providers.cursor.logoutCta')}
                </button>
              ) : auth.kind !== 'loading' ? (
                <button
                  type="button"
                  onClick={() => void handleLogin()}
                  disabled={authBusy}
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
                  {auth.kind === 'login-pending'
                    ? t('settings.providers.cursor.loggingIn')
                    : t('settings.providers.cursor.loginCta')}
                </button>
              ) : null}
              <span className="text-12 text-[var(--text-tertiary)]">
                {t('settings.providers.cursor.optionalHint')}
              </span>
            </div>
          )}
        </div>
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
