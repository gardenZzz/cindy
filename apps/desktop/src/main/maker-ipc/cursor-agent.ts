/**
 * Cursor agent 本机探测 / 官方安装 IPC。
 *
 * - `maker:cursor:binary-status`：查询型，只回 `{ installed }`（不把本机绝对路径回 renderer）。
 * - `maker:cursor:install`：仅在设置页用户确认后调用；跑官方 curl|bash，不自动触发。
 * - `maker:cursor:refresh-models`：设置页「刷新模型」启动串行探测（可重入 + 进行中互斥）。
 * - `maker:cursor:cancel-refresh`：取消进行中的探测。
 * - `maker:cursor:refresh-progress`：main -> renderer 进度推送（已探 n / 总数）。
 */

import { BrowserWindow, ipcMain } from 'electron';

import { createLogger } from '../logger.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import {
  createRunCursorAgentInstallDeps,
  isCursorAgentInstallSupported,
  runCursorAgentInstall,
} from '../maker-host/cursor-agent-install.js';
import { discoverCursorAgentBinary } from '../maker-host/cursor-binary-discovery.js';
import {
  cancelCursorModelRefresh,
  getCursorModelDiscoverer,
  isCursorModelRefreshAvailable,
  startCursorModelRefresh,
} from '../maker-host/cursor-model-discovery.js';

import { MAKER_INVOKE } from './channels.js';

const log = createLogger('maker-ipc:cursor-agent');

export type CursorBinaryStatusView = { installed: boolean };
export type CursorAgentInstallResult = { installed: boolean };
export type CursorRefreshModelsResult = { started: boolean };
export type CursorRefreshProgress = { done: number; total: number; running: boolean };

/** 广播探测进度到所有本地窗口(设置页据此显示「已探 n / 总数」)。 */
function broadcastCursorRefreshProgress(progress: CursorRefreshProgress): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send(MAKER_INVOKE.CURSOR_REFRESH_PROGRESS, progress);
    } catch (e) {
      log.warn(`broadcast cursor refresh progress failed: ${String(e)}`);
    }
  }
}

export function registerCursorAgentIpc(): void {
  log.info('registering cursor-agent IPC handlers');

  ipcMain.handle(
    MAKER_INVOKE.CURSOR_BINARY_STATUS,
    async (event): Promise<CursorBinaryStatusView> => {
      assertTrustedAppRendererEvent(event);
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

  ipcMain.handle(
    MAKER_INVOKE.CURSOR_REFRESH_MODELS,
    async (event): Promise<CursorRefreshModelsResult> => {
      assertTrustedAppRendererEvent(event);
      if (!isCursorModelRefreshAvailable()) {
        // 未注册探针(cursor-agent 未装)-> 未安装语义,调用方据此提示。
        throwIpcError('UNSUPPORTED_CAPABILITY', 'cursor-agent not installed');
      }
      const agent = getCursorModelDiscoverer();
      if (!agent) {
        throwIpcError('INTERNAL', 'cursor discoverer unavailable');
      }
      const handle = startCursorModelRefresh(agent, {
        onProgress: (done, total) => {
          broadcastCursorRefreshProgress({ done, total, running: true });
        },
        onDone: ({ aborted, error }) => {
          // 结束(完成 / 取消 / 失败)广播一次 running:false 收口;agent 侧
          // publishListedModels -> PROVIDER_CHANGED 已刷新选择器。
          broadcastCursorRefreshProgress({ done: 0, total: 0, running: false });
          if (aborted) {
            log.info('cursor model refresh cancelled');
          } else if (error) {
            log.warn('cursor model refresh ended with error', { error });
          }
        },
      });
      // 进行中互斥:同时只跑一轮,再点返回 started:false(不排队、不报错)。
      if (!handle) return { started: false };
      return { started: true };
    },
  );

  ipcMain.handle(
    MAKER_INVOKE.CURSOR_CANCEL_REFRESH,
    async (event): Promise<{ cancelled: boolean }> => {
      assertTrustedAppRendererEvent(event);
      return { cancelled: cancelCursorModelRefresh() };
    },
  );

  log.info('cursor-agent IPC handlers registered');
}
