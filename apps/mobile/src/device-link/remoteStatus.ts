import {
  describeRemoteError as describeRemoteErrorShared,
  humanizeRemoteError as humanizeRemoteErrorShared,
  isCursorUnsupportedRemoteError,
  isDeviceUnresponsiveRemoteError,
} from '@cindy/maker-shared/device-link-contract';
import { i18n } from '@/i18n';

export {
  connectionIssueHint,
  connectionIssueTitle,
  describeAgentAuthError,
  formatRemoteError,
  isCursorUnsupportedRemoteError,
  isPreconditionFailedRemoteError,
  relayStatusHint,
  relayStatusLabel,
} from '@cindy/maker-shared/device-link-contract';

/**
 * mobile 侧的 humanizeRemoteError / describeRemoteError:熔断快速失败
 * (DEVICE_UNRESPONSIVE)先走四语言 i18n(与 ConnectionBanner 同一组文案),
 * 其余委托 maker-shared 原实现。共享层的文案是中文硬编码(历史现状),直接
 * 透出会让 en/ja/ko 用户在 Alert / banner 里看到中文(review P1 两轮)——
 * 本 PR 新增的错误码不再走那条老路。mobile 代码一律从本文件 import,
 * 不要直接 import 共享层的这两个函数。
 */
export function humanizeRemoteError(error: unknown): string {
  if (isDeviceUnresponsiveRemoteError(error)) {
    return i18n.t('deviceLink.deviceUnresponsiveHint');
  }
  return humanizeRemoteErrorShared(error);
}

export function describeRemoteError(error: string | null): string | null {
  if (error?.includes('DEVICE_UNRESPONSIVE')) {
    return i18n.t('deviceLink.deviceUnresponsiveHint');
  }
  if (isCursorUnsupportedRemoteError(error)) {
    return i18n.t('session.screen.cursorUnsupportedOnDesktop');
  }
  return describeRemoteErrorShared(error);
}

/**
 * 新建 / 切换 Cursor 被旧电脑端拒绝时的可读错误。
 * `requestedAgentKind` 用于「错误原文未点名 cursor」的语境判定。
 */
export function describeCursorHostError(
  error: string | null | undefined,
  requestedAgentKind?: string | null,
): string | null {
  if (!isCursorUnsupportedRemoteError(error, requestedAgentKind)) return null;
  return i18n.t('session.screen.cursorUnsupportedOnDesktop');
}
