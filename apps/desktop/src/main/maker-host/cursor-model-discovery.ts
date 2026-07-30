/**
 * cursor-model-discovery —— 把 Cursor ACP session/new 上报的模型清单映射为
 * maker-core ModelDescriptor[]，供 host 注入 CursorAgent.capabilities.availableModels。
 *
 * 与 codex-model-discovery 同构：maker-core 只负责调用时机，映射 / 落盘 / 广播归 host。
 */

import fs from 'node:fs';
import path from 'node:path';

import { app } from 'electron';

import type { Effort, ModelDescriptor } from '@cindy/maker-core';
import {
  cursorListingToDescriptors,
  type CursorModelsListing,
} from '@cindy/maker-core';

import { ownerScopedUserDataPath } from '../appSessionState.js';
import { desktopMakerLogger } from './logger-adapter.js';

/** ACP 上报 → 产品目录描述符。空 listing 返回 []（调用方保留 Auto 兜底）。 */
export function mapCursorAcpModelsToDescriptors(
  listing: CursorModelsListing,
): ModelDescriptor[] {
  return cursorListingToDescriptors(listing.models);
}

/**
 * 目录快照落盘 —— ACP 只在 session/new 才报模型清单，不缓存的话每次冷启动选择器
 * 都只有兜底 Auto，用户必须先发起一次会话才看得到真实模型。
 *
 * 缓存只服务「首次上报前的展示」：本进程内任何一次真实上报都整表覆盖内存与磁盘，
 * 故不做过期判定（陈旧条目最多存活到该 agent 的第一次 session/new）。
 */
const EFFORTS: ReadonlySet<string> = new Set<Effort>([
  'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra',
]);

function cacheFilePath(): string {
  return ownerScopedUserDataPath('cursor-models-cache.json');
}

/** 磁盘 JSON 可能被手改/截断，逐字段收窄后才允许进 capabilities。 */
function sanitizeDescriptors(raw: unknown): ModelDescriptor[] {
  if (!Array.isArray(raw)) return [];
  const out: ModelDescriptor[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const m = item as Record<string, unknown>;
    const id = m.id;
    if (typeof id !== 'string' || id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    const efforts = (Array.isArray(m.efforts) ? m.efforts : []).filter(
      (e): e is Effort => typeof e === 'string' && EFFORTS.has(e),
    );
    const descriptor: ModelDescriptor = {
      id,
      displayName: typeof m.displayName === 'string' && m.displayName.length > 0
        ? m.displayName
        : id,
      contextWindow:
        typeof m.contextWindow === 'number' && m.contextWindow > 0
          ? m.contextWindow
          : 200_000,
      efforts,
      defaultEffort:
        typeof m.defaultEffort === 'string' && efforts.includes(m.defaultEffort as Effort)
          ? (m.defaultEffort as Effort)
          : null,
    };
    if (typeof m.supportsFastMode === 'boolean') descriptor.supportsFastMode = m.supportsFastMode;
    if (typeof m.supportsThinkingMode === 'boolean') {
      descriptor.supportsThinkingMode = m.supportsThinkingMode;
    }
    out.push(descriptor);
  }
  return out;
}

/** 上次上报的目录快照；文件缺失 / 损坏一律回 []（调用方保留 Auto 兜底）。 */
export function readCachedCursorModels(): ModelDescriptor[] {
  try {
    return sanitizeDescriptors(JSON.parse(fs.readFileSync(cacheFilePath(), 'utf-8')));
  } catch {
    return [];
  }
}

/**
 * 后台补一轮全量档位探测（宿主侧触发口）。失败只告警：探测是锦上添花，
 * 用户照常可以建会话，选中某个模型时那条链路仍会补上它自己的档位。
 * 一个进程只跑一次，避免登录失败时每次调用都重来。
 */
let discoveryStarted = false;
export async function discoverCursorModelOptionsInBackground(agent: {
  discoverModelOptions(opts: { workingDir: string; userDataPath: string }): Promise<void>;
}): Promise<void> {
  if (discoveryStarted) return;
  discoveryStarted = true;
  const userDataPath = app.getPath('userData');
  // 空的专用 cwd：不让探测进程去扫用户仓库的 rules / skills。
  const workingDir = path.join(userDataPath, 'cursor-acp', 'model-discovery-cwd');
  try {
    fs.mkdirSync(workingDir, { recursive: true });
    await agent.discoverModelOptions({ workingDir, userDataPath });
  } catch (err) {
    desktopMakerLogger.warn('cursor model option discovery failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** 上报后落盘。内容未变则不写（每次切模型的 config 丰富都会走到这里）。 */
let lastWritten: string | null = null;
export function writeCachedCursorModels(models: readonly ModelDescriptor[]): void {
  if (models.length === 0) return;
  const text = JSON.stringify(models);
  if (text === lastWritten) return;
  const file = cacheFilePath();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, 'utf-8');
    lastWritten = text;
  } catch (err) {
    desktopMakerLogger.warn('cursor model cache write failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
