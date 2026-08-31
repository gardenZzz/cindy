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

/**
 * 目录展示序：显示名字母升序，同显示名按 id 兜底定序。
 *
 * 比较器锁定 `en` 而不跟随应用语言：缓存是跨语言共享的单份快照，跟随语言会让
 * 切换语言产生一次无意义的整表重写。numeric 让版本号按数值排，否则 Opus 10 会
 * 排在 Opus 5 前面。
 */
function byDisplayName(a: ModelDescriptor, b: ModelDescriptor): number {
  return (
    a.displayName.localeCompare(b.displayName, 'en', { numeric: true, sensitivity: 'base' }) ||
    a.id.localeCompare(b.id, 'en')
  );
}

/**
 * ACP 上报 → 产品目录描述符。空 listing 返回 []（调用方保留 Auto 兜底）。
 *
 * capabilities 与磁盘缓存共用这一份数组，选择器顺序因此不再跟着上游数组序漂。
 */
export function mapCursorAcpModelsToDescriptors(
  listing: CursorModelsListing,
): ModelDescriptor[] {
  return cursorListingToDescriptors(listing.models).sort(byDisplayName);
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

/**
 * 上次上报的目录快照；文件缺失 / 损坏一律回 []（调用方保留 Auto 兜底）。
 *
 * 读回时同样排序：升级前写下的缓存是上游数组序，不在这里兜住的话老用户要等到
 * 下一次显式探测刷新才能看到有序列表。这样也省掉一次性迁移代码。
 */
export function readCachedCursorModels(): ModelDescriptor[] {
  try {
    return sanitizeDescriptors(JSON.parse(fs.readFileSync(cacheFilePath(), 'utf-8'))).sort(
      byDisplayName,
    );
  } catch {
    return [];
  }
}

/** 探测目标 agent 接口(由 CursorAgent 实现;单测可注入 fake)。 */
export interface CursorModelDiscoverer {
  discoverModelOptions(opts: {
    workingDir: string;
    userDataPath: string;
    signal?: AbortSignal;
    onProgress?: (done: number, total: number) => void;
  }): Promise<void>;
}

/** 一次刷新的进行中句柄:可取消,也用于进行中互斥(同时只跑一轮)。 */
export interface CursorModelRefreshHandle {
  /** 取消探测;已探到的结果已落盘,未探到的保持原值。 */
  cancel(): void;
}

const REFRESH_CWD_SUBPATH = path.join('cursor-acp', 'model-discovery-cwd');

/**
 * 注入探测目标(maker-host 装配 CursorAgent 后调 setCursorModelDiscoverer;
 * 二进制未装时为 null,刷新入口随之不可用)。IPC 层经 getCursorModelDiscoverer
 * 取实例触发刷新,不直接持有装配期的局部引用。
 */
let discoverer: CursorModelDiscoverer | null = null;
export function setCursorModelDiscoverer(agent: CursorModelDiscoverer | null): void {
  discoverer = agent;
}
export function getCursorModelDiscoverer(): CursorModelDiscoverer | null {
  return discoverer;
}

/** 设置页查询:刷新入口当前是否可用(已注册探针 + 未在进行中)。 */
export function isCursorModelRefreshAvailable(): boolean {
  return discoverer !== null;
}

/**
 * 手动可重入 + 进行中互斥的探测编排(spec #21 / #28)。
 *
 * 目录的唯一写入方:设置页「刷新模型」(与 #29 的「登录成功探一次」复用本编排)。
 * 移除了进程级「只探一次」布尔门:每点一次刷新都真的重跑;探测未结束时再点无效
 * (进行中互斥 -- 返回当前进行中句柄的 cancel,不排队)。支持取消:取消后已探到的
 * 档位保留并落盘,未探到的保持原值。刷新结束(正常完成或取消收尾)由 agent 侧
 * publishListedModels 触发一次目录广播。
 */
let inflight: { controller: AbortController } | null = null;

/**
 * 启动一轮探测。进行中时再调用是 no-op(返回 null),不排队、不重入。
 * 返回句柄供调用方取消;null = 已有一轮在进行中。
 * onProgress 每探完一个模型回调;onDone 在结束(完成 / 取消 / 失败)后回调一次。
 */
export function startCursorModelRefresh(
  agent: CursorModelDiscoverer,
  opts?: {
    onProgress?: (done: number, total: number) => void;
    onDone?: (result: { aborted: boolean; error: string | null }) => void;
  },
): CursorModelRefreshHandle | null {
  if (inflight) return null;
  const controller = new AbortController();
  inflight = { controller };
  const userDataPath = app.getPath('userData');
  // 空的专用 cwd：不让探测进程去扫用户仓库的 rules / skills。
  const workingDir = path.join(userDataPath, REFRESH_CWD_SUBPATH);
  void (async () => {
    let aborted = false;
    let error: string | null = null;
    try {
      fs.mkdirSync(workingDir, { recursive: true });
      await agent.discoverModelOptions({
        workingDir,
        userDataPath,
        signal: controller.signal,
        onProgress: opts?.onProgress,
      });
      aborted = controller.signal.aborted;
    } catch (err) {
      aborted = controller.signal.aborted;
      // 未登录 / 探测出错:由调用方据 agent 状态区分呈现;这里只告警不抛。
      error = err instanceof Error ? err.message : String(err);
      desktopMakerLogger.warn('cursor model refresh failed', {
        aborted,
        error,
      });
    } finally {
      inflight = null;
      try {
        opts?.onDone?.({ aborted, error });
      } catch {
        // onDone 回调失败不影响编排本身。
      }
    }
  })();
  return { cancel: () => controller.abort() };
}

/** 取消进行中的探测;无进行中轮次时 no-op。已探到的结果已落盘。 */
export function cancelCursorModelRefresh(): boolean {
  if (!inflight) return false;
  inflight.controller.abort();
  return true;
}

/** 当前是否有一轮探测在进行中(供设置页按钮态 / 进行中互斥判断)。 */
export function isCursorModelRefreshRunning(): boolean {
  return inflight !== null;
}

/**
 * 后台补一轮全量档位探测(冷启动 / 登录成功触发口)。
 *
 * 复用 startCursorModelRefresh 的同一套编排(进度、取消、落盘、广播)。
 * 与手动刷新的区别:不传 onProgress(冷启动无人看进度),且进行中时 no-op
 * (不抢手动刷新正在跑的那轮)。await 到本轮结束(完成 / 失败)。
 */
export async function discoverCursorModelOptionsInBackground(
  agent: CursorModelDiscoverer,
): Promise<void> {
  // 进行中时不抢(手动刷新正在跑就让它跑完)。
  if (inflight) return;
  await new Promise<void>((resolve) => {
    const handle = startCursorModelRefresh(agent, {
      onDone: () => resolve(),
    });
    if (!handle) resolve();
  });
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
