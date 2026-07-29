/**
 * 官方 cursor-agent 安装 —— 仅在用户于设置页显式确认后由 IPC 调用。
 * 命令与上游一致：`curl -fsSL https://cursor.com/install | bash`（仅 darwin / linux）。
 */

import { spawn } from 'node:child_process';

export const CURSOR_AGENT_INSTALL_URL = 'https://cursor.com/install';

/** 展示给用户确认用的命令文案（与实际 spawn 一致）。 */
export const CURSOR_AGENT_INSTALL_COMMAND = `curl -fsSL ${CURSOR_AGENT_INSTALL_URL} | bash`;

const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

export type CursorAgentInstallPlatform = NodeJS.Platform;

export function isCursorAgentInstallSupported(
  platform: CursorAgentInstallPlatform = process.platform,
): boolean {
  return platform === 'darwin' || platform === 'linux';
}

export interface RunCursorAgentInstallDeps {
  platform: CursorAgentInstallPlatform;
  /** 注入点：生产 = 真实 bash 管道；单测可 stub。 */
  runCommand: (command: string) => Promise<void>;
}

function runBashPipe(command: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/bash', ['-c', command], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`cursor-agent install timed out after ${INSTALL_TIMEOUT_MS}ms`));
    }, INSTALL_TIMEOUT_MS);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      const detail = stderr.trim();
      reject(
        new Error(
          detail
            ? `cursor-agent install failed (exit ${code}): ${detail.slice(0, 500)}`
            : `cursor-agent install failed (exit ${code})`,
        ),
      );
    });
  });
}

export function createRunCursorAgentInstallDeps(
  platform: CursorAgentInstallPlatform = process.platform,
): RunCursorAgentInstallDeps {
  return {
    platform,
    runCommand: runBashPipe,
  };
}

/**
 * 执行官方安装脚本。不支持的平台抛错（由 IPC 转 UNSUPPORTED_CAPABILITY）。
 * 绝不在模块加载或探测路径里自动调用。
 */
export async function runCursorAgentInstall(
  deps: RunCursorAgentInstallDeps = createRunCursorAgentInstallDeps(),
): Promise<void> {
  if (!isCursorAgentInstallSupported(deps.platform)) {
    throw new Error(`cursor-agent official installer does not support ${deps.platform}`);
  }
  await deps.runCommand(CURSOR_AGENT_INSTALL_COMMAND);
}
