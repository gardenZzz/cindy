/**
 * Cursor agent 本机探测 / 官方安装 IPC。
 *
 * - `maker:cursor:binary-status`：查询型，只回 `{ installed }`（不把本机绝对路径回 renderer）。
 * - `maker:cursor:install`：仅在设置页用户确认后调用；跑官方 curl|bash，不自动触发。
 */

import { ipcMain } from 'electron';

import { createLogger } from '../logger.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import {
  createRunCursorAgentInstallDeps,
  isCursorAgentInstallSupported,
  runCursorAgentInstall,
} from '../maker-host/cursor-agent-install.js';
import { discoverCursorAgentBinary } from '../maker-host/cursor-binary-discovery.js';

import { MAKER_INVOKE } from './channels.js';

const log = createLogger('maker-ipc:cursor-agent');

export type CursorBinaryStatusView = { installed: boolean };

export type CursorAgentInstallResult = { installed: boolean };

export function registerCursorAgentIpc(): void {
  log.info('registering cursor-agent IPC handlers');

  ipcMain.handle(
    MAKER_INVOKE.CURSOR_BINARY_STATUS,
    async (): Promise<CursorBinaryStatusView> => {
      try {
        const status = await discoverCursorAgentBinary();
        return { installed: status.installed };
      } catch (err) {
        // 探测失败按未安装降级，不阻塞设置页其它功能。
        log.warn('cursor binary discovery failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        return { installed: false };
      }
    },
  );

  ipcMain.handle(
    MAKER_INVOKE.CURSOR_INSTALL,
    async (event): Promise<CursorAgentInstallResult> => {
      assertTrustedAppRendererEvent(event);
      if (!isCursorAgentInstallSupported()) {
        throwIpcError(
          'UNSUPPORTED_CAPABILITY',
          'Official Cursor agent installer supports macOS and Linux only',
        );
      }
      try {
        await runCursorAgentInstall(createRunCursorAgentInstallDeps());
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn('cursor-agent install failed', { error: message });
        throwIpcError('INTERNAL', message);
      }
      try {
        const status = await discoverCursorAgentBinary();
        return { installed: status.installed };
      } catch {
        return { installed: false };
      }
    },
  );

  log.info('cursor-agent IPC handlers registered');
}
