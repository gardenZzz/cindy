/**
 * CursorAgent — 经官方 ACP (`cursor-agent acp`) 接入的薄子类。
 *
 * T2: initialize → session/new → session/prompt → 文本流式。
 * T3: tool_call* 翻译 + session/request_permission → InteractionRequest；
 *     Ask / Auto / Full 全部在 Cindy 客户端策略层实现。
 * T4: session/new 模型目录上报 host；effort / fast 经 session/set_config_option。
 * T5: session/load resume（跳过上游历史回放）+ invalid-resume CAS；
 *     session/cancel 真停；tool-call 不活动超时；dispose/close 无孤儿进程。
 * T6: cursor/create_plan → plan_review；cursor/ask_question → ask_user_question；
 *     cursor/update_todos → update_plan todo 卡；session/set_mode(plan) ↔ planMode。
 * T7: AuthAdapter（status/login/logout）+ headless oneShot（起标题等）。
 *
 * 按 ADR:
 *  - 不注入任何 Cindy system prompt / makerMemory / userPrompt
 *  - usage 预接 PromptResponse.usage + usage_update, 上游无数据时保持「无数据」
 *  - initialize 声明 `_meta.parameterizedModelPicker: true`
 *  - allow-always 实测为机器级 → 永不下发, 会话记忆留在 Cindy
 *  - cursor 自身 ask 模式不对外暴露（产品面仅 plan ↔ 普通）
 */

import {
  BaseAgent,
  AgentNotAuthenticatedError,
  OneShotError,
  type AgentDeps,
  type AgentSessionHandle,
  type OneShotOptions,
  type SendOptions,
  type StartSessionOptions,
} from '../base-agent.js';
import type { Capabilities, EffortDescriptor, PermissionModeDescriptor } from '../../types/capabilities.js';
import { NotSupportedError } from '../../types/capabilities.js';
import type {
  AgentEvent,
  InteractionDecision,
  InteractionRequest,
  InteractionResolver,
  UsageSnapshot,
} from '../../types/events.js';
import { promises as fs } from 'node:fs';
import { extname } from 'node:path';
import type { Effort, PermissionMode, UserContentBlock, UserMessage } from '../../types/common.js';
import { createAsyncQueue, type AsyncQueue } from '../shared/async-queue.js';
import { getDefaultImageResizer } from '../shared/image-resizer.js';
import { UsageTracker } from '../shared/usage-tracker.js';
import {
  AcpClient,
  ACP_PROTOCOL_VERSION,
  cancelledPermissionResult,
  createAcpStdioTransport,
  CursorMethod,
  finishPromptTurn,
  Method,
  newAcpRuntime,
  permissionToolCall,
  resetAcpTurn,
  sessionAllowKeyFromSuggestion,
  sessionAllowKeyFromToolCall,
  toInteractionRequest,
  toRequestPermissionResult,
  toolInputFromAcpToolCall,
  toolNameFromAcpToolCall,
  translateAcpError,
  translateSessionUpdate,
  type AcpConfigOption,
  type AcpTranslateContext,
  type ContentBlock,
  type LoadSessionResponse,
  type NewSessionResponse,
  type PromptResponse,
  type RequestPermissionParams,
  type RequestPermissionResult,
  type SetConfigOptionResult,
  type Transport,
} from '../acp/index.js';
import { createCursorIsolatedConfigDir } from './isolatedConfig.js';
import { isCursorResumeSessionNotFound } from './invalidResume.js';
import {
  askQuestionResponseFromDecision,
  createPlanResponseFromDecision,
  CURSOR_TODOS_TOOL_USE_ID,
  mergeCursorTodos,
  parseAskQuestionParams,
  parseCreatePlanParams,
  parseUpdateTodosParams,
  toAskUserQuestionRequest,
  todosToUpdatePlanEvents,
  toPlanReviewRequest,
  updateTodosAcceptedResponse,
  type CursorTodoItem,
} from './extensions.js';
import {
  createToolIdleWatchdog,
  formatCursorInvalidResumeCasConflictMessage,
  formatCursorInvalidResumeMessage,
  formatCursorToolIdleMessage,
  resolveCursorToolIdleMs,
  type ToolIdleWatchdog,
} from './toolIdleWatchdog.js';
import {
  cursorAutoModelFallback,
  enrichCursorModelFromConfigOptions,
  findCursorEffortOption,
  parseAcpConfigOptions,
  parseCursorModelsState,
  readConfigOptionValue,
  toCursorAcpModelId,
  toCursorConfigEffortValue,
  toCursorEffort,
  toCursorProductModelId,
  type CursorListedModel,
} from './models.js';
import { CURSOR_ONESHOT_DEFAULT_MODEL, runCursorOneShot } from './oneShot.js';

/** Auto 分类器超时（与 Codex Guardian 不可用时的 408 语义对齐）。 */
const AUTO_PERMISSION_CLASSIFIER_TIMEOUT_MS = 8_000;

function raceAutoPermissionClassifier(
  classify: Promise<'allow' | 'ask'>,
  timeoutMs: number,
): Promise<'allow' | 'ask'> {
  return new Promise<'allow' | 'ask'>((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error('auto permission classifier timed out');
      Object.assign(err, { status: 408 });
      reject(err);
    }, timeoutMs);
    timer.unref?.();
    classify.then(
      (verdict) => {
        clearTimeout(timer);
        resolve(verdict);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

const UNSUPPORTED = {
  rewind: {
    supported: false as const,
    reason: 'sdk-missing' as const,
    message: 'Cursor ACP 不支持 rewind',
  },
  fork: {
    supported: false as const,
    reason: 'sdk-missing' as const,
    message: 'Cursor ACP 不支持 fork',
  },
  sameTurnSteer: {
    supported: false as const,
    reason: 'not-implemented' as const,
    message: 'Cursor 同 turn 插话尚未实现',
  },
  extraDirs: {
    supported: false as const,
    reason: 'not-implemented' as const,
    message: 'Cursor extraDirs 尚未接线',
  },
  memory: {
    supported: false as const,
    reason: 'sdk-missing' as const,
    message: 'Cursor 会话不注入 Cindy system prompt / makerMemory (ACP 无注入面)',
  },
};

const CURSOR_EFFORT_LEVELS: EffortDescriptor[] = [
  // minimal 对应上游 GPT 系的 `none` 档（reasoning=none）。
  { id: 'minimal', displayName: 'Minimal', description: 'No extra reasoning budget' },
  { id: 'low', displayName: 'Low', description: 'Fast responses with minimal reasoning' },
  { id: 'medium', displayName: 'Medium', description: 'Balanced reasoning depth' },
  { id: 'high', displayName: 'High', description: 'Deeper reasoning for harder tasks' },
  { id: 'xhigh', displayName: 'Extra High', description: 'Extended reasoning budget' },
  { id: 'max', displayName: 'Max', description: 'Very high reasoning budget (model-dependent)' },
];

/** 目录上报失败 / 尚未建立会话时的兜底：选择器至少能选 Auto，不卡住新建。 */
const CURSOR_AUTO_MODEL = cursorAutoModelFallback();

const CURSOR_PERMISSION_MODES: PermissionModeDescriptor[] = [
  {
    id: 'ask',
    displayName: 'Default permissions',
    description: 'Ask before running tools that need approval',
  },
  {
    id: 'auto',
    displayName: 'Auto',
    description: 'Auto-allow read/search/think; ask for higher-risk tools',
  },
  {
    id: 'bypassPermissions',
    displayName: 'Full access',
    description: 'Allow all tool calls without prompting',
  },
];

const CAPABILITIES: Capabilities = {
  switchModel: { supported: true },
  availableModels: [
    {
      id: CURSOR_AUTO_MODEL.id,
      displayName: CURSOR_AUTO_MODEL.displayName,
      contextWindow: CURSOR_AUTO_MODEL.contextWindow,
      efforts: CURSOR_AUTO_MODEL.efforts,
      defaultEffort: CURSOR_AUTO_MODEL.defaultEffort,
    },
  ],
  hasFastMode: true,
  effort: { supported: true },
  effortLevels: CURSOR_EFFORT_LEVELS,
  reasoningDisplay: ['off'],
  permissionModes: CURSOR_PERMISSION_MODES,
  setPermissionModeMidSession: { supported: true },
  planMode: { supported: true },
  multimodal: {
    text: { supported: true },
    image: { supported: true },
    file: { supported: false, reason: 'not-implemented', message: 'Cursor ACP file prompt 尚未接线' },
  },
  fork: UNSUPPORTED.fork,
  rewind: UNSUPPORTED.rewind,
  abort: { supported: true },
  sameTurnSteer: UNSUPPORTED.sameTurnSteer,
  memory: {
    supported: UNSUPPORTED.memory,
  },
  extraDirs: UNSUPPORTED.extraDirs,
};

function stripFileUrl(raw: string): string {
  if (!raw.startsWith('file://')) return raw;
  try {
    return decodeURIComponent(raw.slice('file://'.length));
  } catch {
    return raw.slice('file://'.length);
  }
}

function mimeTypeForImagePath(filePath: string, provided?: string): string {
  if (provided && provided.trim()) return provided.trim();
  switch (extname(filePath).toLowerCase()) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.bmp':
      return 'image/bmp';
    case '.png':
    default:
      return 'image/png';
  }
}

/** ACP prompt 内嵌 base64 前，单图（resize 后）字节上限。 */
export const CURSOR_PROMPT_IMAGE_MAX_BYTES = 20 * 1024 * 1024;

export type CursorImageBytesReader = (filePath: string) => Promise<Buffer>;

const defaultImageBytesReader: CursorImageBytesReader = (filePath) => fs.readFile(filePath);

let imageBytesReader: CursorImageBytesReader = defaultImageBytesReader;
let promptImageMaxBytes = CURSOR_PROMPT_IMAGE_MAX_BYTES;

/** @internal 单测注入慢 reader / 恢复默认。 */
export function __setCursorImageBytesReaderForTesting(
  reader: CursorImageBytesReader | null,
): void {
  imageBytesReader = reader ?? defaultImageBytesReader;
}

/** @internal 单测注入超限阈值 / 恢复默认。 */
export function __setCursorPromptImageMaxBytesForTesting(maxBytes: number | null): void {
  promptImageMaxBytes = maxBytes ?? CURSOR_PROMPT_IMAGE_MAX_BYTES;
}

/**
 * Encode Cindy UserMessage into ACP prompt blocks.
 * Image blocks become real `ImageContentBlock` (base64 data + mimeType, or http(s) uri).
 *
 * Async：本地图先经 image-resizer（与 Claude/Codex 同 maxEdgePx 等默认上限），
 * 再 `fs.promises.readFile` —— 禁止在 Main 热路径上 sync 读整图。
 */
export async function userMessageToPromptBlocks(message: UserMessage): Promise<ContentBlock[]> {
  const content = message.content;
  if (typeof content === 'string') {
    return content.length > 0 ? [{ type: 'text', text: content }] : [];
  }
  const blocks: ContentBlock[] = [];
  const resizer = getDefaultImageResizer();

  // 同 turn 多张本地图并发缩，semaphore 在 resizer 内部控并发。
  const localImageJobs = new Map<number, Promise<string>>();
  content.forEach((block, idx) => {
    if (block.type !== 'image') return;
    const raw = block.path;
    if (raw.startsWith('http://') || raw.startsWith('https://')) return;
    localImageJobs.set(idx, resizer.process(stripFileUrl(raw)));
  });
  const resizedPaths = new Map<number, string>();
  for (const [idx, p] of localImageJobs) {
    resizedPaths.set(idx, await p);
  }

  for (let idx = 0; idx < content.length; idx++) {
    const block = content[idx] as UserContentBlock;
    if (block.type === 'text' && block.text.length > 0) {
      blocks.push({ type: 'text', text: block.text });
      continue;
    }
    if (block.type === 'image') {
      const raw = block.path;
      if (raw.startsWith('http://') || raw.startsWith('https://')) {
        blocks.push({
          type: 'image',
          uri: raw,
          mimeType: mimeTypeForImagePath(raw, block.mimeType),
        });
        continue;
      }
      const originalPath = stripFileUrl(raw);
      const filePath = resizedPaths.get(idx) ?? originalPath;
      // resizer 返回替代路径（通常 .webp）时必须从该路径推导 MIME；
      // 原样返回原路径（跳过阈值 / sharp 不可用 / 失败降级）才沿用 block.mimeType。
      const mimeType =
        filePath === originalPath
          ? mimeTypeForImagePath(filePath, block.mimeType)
          : mimeTypeForImagePath(filePath);
      let statSize: number | undefined;
      try {
        statSize = (await fs.stat(filePath)).size;
      } catch {
        // fall through — reader will surface the error
      }
      if (typeof statSize === 'number' && statSize > promptImageMaxBytes) {
        throw new Error(
          `Cursor send: image exceeds ${promptImageMaxBytes} bytes at ${filePath} (${statSize} bytes)`,
        );
      }
      let data: string;
      try {
        const buf = await imageBytesReader(filePath);
        if (buf.byteLength > promptImageMaxBytes) {
          throw new Error(
            `Cursor send: image exceeds ${promptImageMaxBytes} bytes at ${filePath} (${buf.byteLength} bytes)`,
          );
        }
        data = buf.toString('base64');
      } catch (err) {
        if (err instanceof Error && err.message.includes('image exceeds')) throw err;
        throw new Error(
          `Cursor send: failed to read image at ${filePath}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      blocks.push({
        type: 'image',
        data,
        mimeType,
      });
      continue;
    }
    if (block.type === 'mention') {
      blocks.push({ type: 'text', text: `@${block.name}` });
      continue;
    }
    if (block.type === 'file') {
      blocks.push({ type: 'text', text: `[file: ${block.path}]` });
    }
  }
  return blocks;
}

function normalizeCursorPermissionMode(mode: PermissionMode | undefined): PermissionMode {
  if (mode === 'auto' || mode === 'bypassPermissions' || mode === 'ask') return mode;
  // acceptEdits / plan / default → ask
  return 'ask';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** 单测可经 vendorOptions.createAcpTransport 注入 FakeTransport。 */
function resolveCreateTransport(
  opts: StartSessionOptions,
  deps: AgentDeps,
  isolatedEnv: NodeJS.ProcessEnv,
): () => Transport {
  const injected = opts.vendorOptions?.createAcpTransport;
  if (typeof injected === 'function') {
    return injected as () => Transport;
  }
  return () =>
    createAcpStdioTransport({
      binaryPath: deps.binaryPath,
      args: ['acp'],
      cwd: opts.workingDir,
      env: isolatedEnv,
    });
}

export class CursorAgent extends BaseAgent {
  readonly kind = 'cursor' as const;
  readonly capabilities: Capabilities;

  /** 跨会话缓存最近一次上报的目录（含 set_config_option 丰富后的 effort/fast）。 */
  private listedModels: CursorListedModel[] = [cursorAutoModelFallback()];

  /** 仍存活的会话 close 钩子 — dispose() 时 drain，防孤儿。 */
  private readonly liveSessionClosers = new Set<() => Promise<void>>();

  constructor(deps: AgentDeps) {
    super(deps);
    this.capabilities = this.buildCapabilities(CAPABILITIES);
  }

  /**
   * 用宿主的持久化快照预热目录。session/new 只报 id + 名字，档位靠
   * applyModelsFromSessionPayload 的「同 id 保旧」合并续上——不预热，冷启动第一次
   * 建会话就会把上次探到的 effort / context 全抹平。空数组 = no-op。
   */
  seedListedModels(models: readonly CursorListedModel[]): void {
    if (models.length === 0) return;
    this.listedModels = models.map((m) => ({ ...m, efforts: [...m.efforts] }));
  }

  private async publishListedModels(currentModelId: string): Promise<void> {
    const listing = {
      currentModelId,
      models: this.listedModels.map((m) => ({ ...m, efforts: [...m.efforts] })),
    };
    try {
      await this.deps.onCursorLocalModelsListed?.(listing);
    } catch (err) {
      this.deps.logger.warn('onCursorLocalModelsListed failed', {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * 全量目录探测：ACP 只在「切到某模型」后才回该模型的 effort / fast / context，
   * 所以不遍历就只有当前模型有推理强度可选，选择器里其它模型是空的。
   *
   * 用一次性 ACP 会话跑，绝不碰用户会话的当前模型；结果照常经
   * onCursorLocalModelsListed 交给宿主落盘 + 广播（宿主负责只跑一次）。
   *
   * ponytail: 串行探测，实测每个模型约 3s（29 个模型近 100s）——所以只能后台跑、
   * 结果必须落盘复用。要更快就得开多个 ACP 会话并行探，等有人真嫌慢再说。
   */
  async discoverModelOptions(opts: {
    workingDir: string;
    userDataPath: string;
    signal?: AbortSignal;
    /** 单测注入 FakeTransport；缺省 spawn 真 cursor-agent。 */
    createTransport?: () => Transport;
  }): Promise<void> {
    const log = this.deps.logger.child('cursor/model-discovery');
    const authState = await this.deps.auth.getState();
    if (!authState.authenticated) {
      throw new AgentNotAuthenticatedError(
        'cursor',
        `cursor not authenticated: ${authState.errorReason ?? 'no_credentials'}`,
      );
    }
    const isolated = createCursorIsolatedConfigDir(process.env, {
      stableKey: 'model-discovery',
      userDataPath: opts.userDataPath,
    });
    const client = new AcpClient({
      createTransport:
        opts.createTransport ??
        (() =>
          createAcpStdioTransport({
            binaryPath: this.deps.binaryPath,
            args: ['acp'],
            cwd: opts.workingDir,
            env: isolated.env,
          })),
      logger: log,
      onTransportError: (err) => log.warn('discovery transport error', { message: err.message }),
    });
    client.start();
    try {
      await client.initialize({
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          // 不声明就拿不到参数化 picker：模型 id 会带死参数、effort 选项整个消失。
          _meta: { parameterizedModelPicker: true },
        },
        clientInfo: { name: 'cindy', title: 'Cindy', version: '0.0.0' },
      });
      const created = await client.request<NewSessionResponse>(Method.SessionNew, {
        cwd: opts.workingDir,
        mcpServers: [],
      });
      const parsed = parseCursorModelsState(created?.models);
      if (!parsed) {
        log.warn('discovery got no models; keeping previous listing');
        return;
      }
      // 同 id 保旧：某个模型这轮探失败时，仍留着上次（或宿主预热）探到的档位；
      // 探成功的会被紧接着的 enrich 覆盖。名字 / 顺序一律以本轮上报为准。
      const prevById = new Map(this.listedModels.map((m) => [m.id, m]));
      this.listedModels = parsed.models.map((m) => {
        const prev = prevById.get(m.id);
        return prev
          ? {
              ...m,
              efforts: prev.efforts,
              defaultEffort: prev.defaultEffort,
              supportsFastMode: prev.supportsFastMode,
              supportsThinkingMode: prev.supportsThinkingMode,
              contextWindow: prev.contextWindow,
            }
          : { ...m };
      });
      const sessionId = created.sessionId;
      for (const model of this.listedModels) {
        if (opts.signal?.aborted) break;
        try {
          const result = await client.request<SetConfigOptionResult>(
            Method.SessionSetConfigOption,
            { sessionId, configId: 'model', value: toCursorAcpModelId(model.id) },
          );
          enrichCursorModelFromConfigOptions(
            this.listedModels,
            model.id,
            parseAcpConfigOptions(result?.configOptions),
          );
        } catch (err) {
          // 单个模型探测失败不该毁掉整轮：该模型保持「无档位」，其余照常。
          log.warn('discovery model probe failed', {
            model: model.id,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
      await this.publishListedModels(parsed.currentModelId);
      log.info('model options discovered', { models: this.listedModels.length });
    } finally {
      await client.close({ reason: 'model discovery done' }).catch(() => undefined);
      isolated.dispose();
    }
  }

  async dispose(): Promise<void> {
    const closers = Array.from(this.liveSessionClosers);
    this.liveSessionClosers.clear();
    await Promise.all(
      closers.map((close) =>
        close().catch((err) => {
          this.deps.logger.warn('CursorAgent.dispose session close failed', {
            message: err instanceof Error ? err.message : String(err),
          });
        }),
      ),
    );
  }

  /**
   * headless oneShot：`cursor-agent -p --output-format text` + 便宜模型。
   * 供起标题等辅助任务；与 ACP 会话通道正交。
   */
  async oneShot(prompt: string, opts?: OneShotOptions): Promise<string> {
    const log = this.deps.logger.child('cursor/oneShot');
    const model = opts?.model ?? CURSOR_ONESHOT_DEFAULT_MODEL;
    const timeoutMs = opts?.timeoutMs ?? 30_000;
    if (opts?.maxTokens !== undefined) {
      log.warn(`maxTokens=${opts.maxTokens} ignored — cursor-agent -p has no max_tokens flag`);
    }

    const authState = await this.deps.auth.getState();
    if (!authState.authenticated) {
      throw new AgentNotAuthenticatedError(
        'cursor',
        `cursor not authenticated: ${authState.errorReason ?? 'no_credentials'}`,
      );
    }

    const startedAt = Date.now();
    try {
      const text = await runCursorOneShot({
        binaryPath: this.deps.binaryPath,
        prompt,
        model,
        timeoutMs,
        signal: opts?.signal,
      });
      log.info('oneShot done', {
        model,
        elapsedMs: Date.now() - startedAt,
        chars: text.length,
      });
      return text;
    } catch (err) {
      if (err instanceof AgentNotAuthenticatedError || err instanceof OneShotError) throw err;
      if (opts?.signal?.aborted) throw err;
      log.error('oneShot failed', {
        model,
        elapsedMs: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
      });
      throw new OneShotError(
        'malformed',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  async startSession(opts: StartSessionOptions): Promise<AgentSessionHandle> {
    // ADR: 不消费 userPrompt / makerMemoryEnabled / runtimeConfig.systemPrompt。
    const log = this.deps.logger.child('cursor-agent');

    // Auth gate：未登录直接拒，给出可读 reason（no_credentials），不 spawn ACP。
    const authState = await this.deps.auth.getState();
    if (!authState.authenticated) {
      throw new AgentNotAuthenticatedError(
        'cursor',
        `cursor not authenticated: ${authState.errorReason ?? 'no_credentials'}`,
      );
    }

    const eventQueue: AsyncQueue<AgentEvent> = createAsyncQueue();
    const usageTracker = new UsageTracker();
    const rt = newAcpRuntime();
    const translateCtx: AcpTranslateContext = {
      rt,
      usage: usageTracker,
      log,
      source: 'cursor',
    };

    let interactionResolver: InteractionResolver | null = null;
    let closed = false;
    let turnInFlight = false;
    /**
     * Per-turn generation token。每次 send 递增；abort / watchdog / prompt 收尾
     * 只有持有当前 active token 才能改状态、清 watchdog、发 done/status。
     * 晚到的旧轮响应一律丢弃，避免污染下一轮。
     */
    let turnGeneration = 0;
    /** 已由 abort / tool-idle 推过终态的 generation；同 token 的 prompt 收尾跳过二次 done/error。 */
    let lastFinalizedGeneration = 0;
    let sessionId = '';
    let mutablePermissionMode = normalizeCursorPermissionMode(opts.permissionMode);
    /** UI 武装态：send 消耗后熄灭；ACP 侧 sticky plan 另用 acpInPlanMode。 */
    let mutablePlanMode = opts.planMode === true;
    /** 上游 session 当前是否处于 plan mode（session/set_mode）。 */
    let acpInPlanMode = opts.planMode === true;
    let mutableModel = toCursorProductModelId(opts.model || CURSOR_AUTO_MODEL.id);
    let mutableEffort: Effort | undefined = opts.effort;
    let mutableFastMode = opts.fastMode === true;
    // Thinking 非可选：有 ACP thinking option 时始终 true（对齐 Codex/CC，忽略 start false）。
    let mutableThinkingMode = true;
    let latestConfigOptions: AcpConfigOption[] = [];
    const sessionAllowKeys = new Set<string>();
    let autoFallbackNotified = false;
    /** session/load 回放历史期间为 true — Cindy 自有存储渲染，跳过上游回放。 */
    let suppressHistoryReplay = false;
    /** cursor/update_todos merge 用的会话内快照。 */
    let cursorTodos: CursorTodoItem[] = [];
    let extensionSeq = 0;

    const userDataPath = this.deps.runtimeConfig.userDataPath;
    if (!userDataPath || !userDataPath.trim()) {
      throw new Error(
        'CursorAgent requires runtimeConfig.userDataPath (host must inject; no HOME fallback)',
      );
    }
    const isolated = createCursorIsolatedConfigDir(process.env, {
      stableKey: opts.sessionId,
      userDataPath,
    });

    const pushAll = (events: AgentEvent[]): void => {
      for (const ev of events) eventQueue.push(ev);
    };

    const client = new AcpClient({
      createTransport: resolveCreateTransport(opts, this.deps, isolated.env),
      logger: log,
      onTransportError: (err) => {
        log.error('transport error', { message: err.message });
        if (!closed) {
          pushAll(translateAcpError(err, translateCtx));
          eventQueue.end();
        }
      },
    });

    const toolIdle: ToolIdleWatchdog = createToolIdleWatchdog({
      idleMs: resolveCursorToolIdleMs(process.env),
      onTimeout: ({ idleMs, pendingToolIds }) => {
        if (closed || !turnInFlight || lastFinalizedGeneration === turnGeneration) return;
        log.warn('cursor tool-call idle watchdog tripped', {
          idleMs,
          pendingToolIds,
          sessionId,
          turnGeneration,
        });
        void finalizeTurnCancel({
          reason: 'tool_call_idle_timeout',
          errorMessage: formatCursorToolIdleMessage(idleMs),
        });
      },
    });

    const setConfigOption = async (
      configId: string,
      value: string,
    ): Promise<AcpConfigOption[]> => {
      const result = await client.request<SetConfigOptionResult>(Method.SessionSetConfigOption, {
        sessionId,
        configId,
        value,
      });
      const options = parseAcpConfigOptions(result?.configOptions);
      if (options.length > 0) latestConfigOptions = options;
      return options.length > 0 ? options : latestConfigOptions;
    };

    const applyConfigEnrichment = async (productModelId: string, options: AcpConfigOption[]) => {
      enrichCursorModelFromConfigOptions(this.listedModels, productModelId, options);
      const effortOpt = findCursorEffortOption(options);
      const effortVal = effortOpt ? toCursorEffort(effortOpt.currentValue) : null;
      if (effortVal) mutableEffort = effortVal;
      const fastVal = readConfigOptionValue(options, 'fast');
      if (fastVal === 'true' || fastVal === 'false') {
        mutableFastMode = fastVal === 'true';
      }
      // 有 thinking option 时本地状态恒 true；上游 currentValue=false 也忽略。
      if (options.some((o) => o.id === 'thinking')) {
        mutableThinkingMode = true;
      }
      await this.publishListedModels(productModelId);
    };

    const applyModelsFromSessionPayload = async (
      payload: NewSessionResponse | LoadSessionResponse,
    ) => {
      const parsed = parseCursorModelsState(payload.models);
      if (parsed) {
        const prevById = new Map(this.listedModels.map((m) => [m.id, m]));
        this.listedModels = parsed.models.map((m) => {
          const prev = prevById.get(m.id);
          return prev
            ? {
                ...m,
                efforts: prev.efforts.length > 0 ? prev.efforts : m.efforts,
                defaultEffort: prev.defaultEffort ?? m.defaultEffort,
                supportsFastMode: prev.supportsFastMode ?? m.supportsFastMode,
                supportsThinkingMode: prev.supportsThinkingMode ?? m.supportsThinkingMode,
                contextWindow: prev.contextWindow !== 200_000 ? prev.contextWindow : m.contextWindow,
              }
            : m;
        });
        mutableModel = parsed.currentModelId;
      } else {
        log.warn('cursor session models missing or empty; keeping Auto fallback');
      }
      latestConfigOptions = parseAcpConfigOptions(payload.configOptions);
      await this.publishListedModels(mutableModel);
    };

    const trackToolActivityFromUpdate = (params: unknown): void => {
      if (!isRecord(params)) return;
      const update = params.update;
      if (!isRecord(update) || typeof update.sessionUpdate !== 'string') return;
      const kind = update.sessionUpdate;
      if (kind === 'tool_call' || kind === 'tool_call_update') {
        const toolCallId = typeof update.toolCallId === 'string' ? update.toolCallId : '';
        const status = typeof update.status === 'string' ? update.status : undefined;
        if (!toolCallId) return;
        if (status === 'completed' || status === 'failed') {
          toolIdle.noteToolTerminal(toolCallId);
        } else {
          toolIdle.noteToolActive(toolCallId);
        }
        toolIdle.noteActivity();
        return;
      }
      // 文本 / 其它 update 也算活动（仅在已有 pending tool 时重置计时）
      toolIdle.noteActivity();
    };

    client.onNotification(Method.SessionUpdate, (params) => {
      if (suppressHistoryReplay) {
        // 上游 session/load 会回放历史；Cindy 用自有存储渲染，这里整段丢弃。
        return;
      }
      trackToolActivityFromUpdate(params);
      pushAll(translateSessionUpdate(params, translateCtx));
    });

    // ── dispatchInteraction + pendingApprovals (Codex 同款 dismiss 模式) ──
    interface PendingEntry {
      resolve: (result: RequestPermissionResult) => void;
      settled: boolean;
    }
    interface PendingExtensionEntry {
      kind: 'ask_user_question' | 'plan_review';
      resolve: (result: unknown) => void;
      settled: boolean;
    }
    const pendingApprovals = new Map<string, PendingEntry>();
    const pendingExtensions = new Map<string, PendingExtensionEntry>();
    let permissionSeq = 0;

    const sessionSuggestionsFor = (sessionAllowKey: string) =>
      this.createSessionPermissionUpdates({
        type: 'cursorSessionApproval',
        sessionAllowKey,
      });

    function defaultInteractionDecision(req: InteractionRequest, reason: string): InteractionDecision {
      if (req.kind === 'ask_user_question') {
        return { kind: 'ask_user_question', answers: {} };
      }
      if (req.kind === 'plan_review') {
        return { kind: 'plan_review', behavior: 'deny', reason, dismissed: true };
      }
      return { kind: 'permission', behavior: 'deny', reason };
    }

    async function dispatchInteraction(req: InteractionRequest): Promise<InteractionDecision> {
      if (!interactionResolver) {
        log.warn('dispatchInteraction without resolver — defaulting to deny/skip', {
          kind: req.kind,
          requestId: req.requestId,
        });
        return defaultInteractionDecision(req, 'no_interaction_resolver');
      }
      try {
        return await interactionResolver(req);
      } catch (e) {
        log.error('interactionResolver threw → deny/skip', {
          kind: req.kind,
          message: (e as Error).message,
        });
        return defaultInteractionDecision(req, 'interaction_resolver_error');
      }
    }

    function dismissAllPending(reason: string, resolveAs: 'allow' | 'deny'): void {
      if (pendingApprovals.size > 0) {
        const entries = Array.from(pendingApprovals.entries());
        for (const [requestId, entry] of entries) {
          if (entry.settled) continue;
          entry.settled = true;
          pendingApprovals.delete(requestId);
          const result: RequestPermissionResult =
            resolveAs === 'allow'
              ? { outcome: { outcome: 'selected', optionId: 'allow-once' } }
              : cancelledPermissionResult();
          entry.resolve(result);
          eventQueue.push({
            type: 'interaction_dismissed',
            data: { requestId, reason, resolvedAs: resolveAs },
            source: 'cursor',
          });
        }
      }
      if (pendingExtensions.size > 0) {
        const entries = Array.from(pendingExtensions.entries());
        for (const [requestId, entry] of entries) {
          if (entry.settled) continue;
          entry.settled = true;
          pendingExtensions.delete(requestId);
          if (entry.kind === 'ask_user_question') {
            entry.resolve({ outcome: { outcome: 'cancelled' } });
          } else {
            entry.resolve({
              outcome:
                resolveAs === 'allow'
                  ? { outcome: 'accepted' }
                  : { outcome: 'cancelled' },
            });
          }
          eventQueue.push({
            type: 'interaction_dismissed',
            data: { requestId, reason, resolvedAs: resolveAs },
            source: 'cursor',
          });
        }
      }
    }

    const applyAcpSessionMode = async (modeId: 'agent' | 'plan'): Promise<void> => {
      if (!sessionId) return;
      await client.request(Method.SessionSetMode, { sessionId, modeId });
      acpInPlanMode = modeId === 'plan';
    };

    const exitPlanModeAfterApproval = async (): Promise<void> => {
      if (mutablePlanMode) {
        mutablePlanMode = false;
        eventQueue.push({ type: 'plan_mode_changed', data: { enabled: false }, source: 'cursor' });
      }
      if (acpInPlanMode) {
        try {
          await applyAcpSessionMode('agent');
        } catch (e) {
          log.warn('post-plan-approval session/set_mode(agent) failed', {
            message: e instanceof Error ? e.message : String(e),
          });
          acpInPlanMode = false;
        }
      }
    };

    const notifyAutoClassifierUnavailable = (status: number) => {
      if (autoFallbackNotified) return;
      autoFallbackNotified = true;
      const notify = this.deps.onAutoPermissionClassifierUnavailable;
      if (!notify) return;
      try {
        notify({
          sessionId: opts.sessionId ?? sessionId,
          agentKind: 'cursor',
          status,
        });
      } catch (e) {
        log.warn('onAutoPermissionClassifierUnavailable threw', {
          message: (e as Error).message,
        });
      }
    };

    const handleRequestPermission = async (
      params: unknown,
      meta: { id: string | number; method: string },
    ): Promise<RequestPermissionResult> => {
      toolIdle.noteActivity();
      const requestId = `cursor-perm:${String(meta.id)}:${++permissionSeq}`;
      const permParams = (
        isRecord(params) ? params : { sessionId: '', toolCall: {}, options: [] }
      ) as unknown as RequestPermissionParams;
      const toolCall = permissionToolCall(permParams);
      const sessionAllowKey = sessionAllowKeyFromToolCall(toolCall);
      const options = Array.isArray(permParams.options) ? permParams.options : [];
      const toolName = toolNameFromAcpToolCall(toolCall);
      const toolInput = toolInputFromAcpToolCall(toolCall);

      // Full access: 静默放行 (只回 allow-once, 不写机器级 allowlist)
      if (mutablePermissionMode === 'bypassPermissions') {
        return toRequestPermissionResult(
          { kind: 'permission', behavior: 'allow' },
          options,
        );
      }

      // 本会话已批准的指纹
      if (sessionAllowKeys.has(sessionAllowKey)) {
        return toRequestPermissionResult(
          { kind: 'permission', behavior: 'allow' },
          options,
        );
      }

      // Auto: 调用注入的分类器（tool 名 + 完整 input）；缺失/超时/抛错 → Ask + fallback hook
      if (mutablePermissionMode === 'auto') {
        const classify = this.deps.classifyAutoPermission;
        if (!classify) {
          log.warn('auto classifier missing — falling back to ask');
          notifyAutoClassifierUnavailable(500);
          mutablePermissionMode = 'ask';
        } else {
          try {
            const verdict = await raceAutoPermissionClassifier(
              Promise.resolve(
                classify({
                  toolName,
                  input: toolInput,
                  kind: typeof toolCall.kind === 'string' ? toolCall.kind : null,
                }),
              ),
              AUTO_PERMISSION_CLASSIFIER_TIMEOUT_MS,
            );
            if (verdict === 'allow') {
              return toRequestPermissionResult(
                { kind: 'permission', behavior: 'allow' },
                options,
              );
            }
          } catch (e) {
            const status =
              e && typeof e === 'object' && 'status' in e && typeof (e as { status: unknown }).status === 'number'
                ? (e as { status: number }).status
                : 500;
            log.warn('auto classifier failed — falling back to ask', {
              message: e instanceof Error ? e.message : String(e),
              status,
            });
            notifyAutoClassifierUnavailable(status);
            mutablePermissionMode = 'ask';
          }
        }
      }

      // Ask (或 Auto 未放行): 弹 UI
      const req = toInteractionRequest({
        requestId,
        params: permParams,
        suggestions: sessionSuggestionsFor(sessionAllowKey),
      });

      return await new Promise<RequestPermissionResult>((resolve) => {
        const entry: PendingEntry = { resolve, settled: false };
        pendingApprovals.set(requestId, entry);
        const finalize = (result: RequestPermissionResult) => {
          if (entry.settled) return;
          entry.settled = true;
          pendingApprovals.delete(requestId);
          resolve(result);
        };

        dispatchInteraction(req)
          .then((decision) => {
            if (decision.kind !== 'permission') {
              log.warn('unexpected non-permission decision → reject', { kind: decision.kind });
              finalize(
                toRequestPermissionResult(
                  { kind: 'permission', behavior: 'deny' },
                  options,
                ),
              );
              return;
            }
            if (
              decision.behavior === 'allow' &&
              this.permissionDecisionRequestsSessionApproval(decision)
            ) {
              for (const update of decision.permissionUpdates ?? []) {
                const key = sessionAllowKeyFromSuggestion(update) ?? sessionAllowKey;
                sessionAllowKeys.add(key);
              }
            }
            // 绝不下发 allow-always（机器级）
            finalize(toRequestPermissionResult(decision, options));
          })
          .catch((e) => {
            log.error('dispatchInteraction threw → reject', {
              requestId,
              message: (e as Error).message,
            });
            finalize(
              toRequestPermissionResult(
                { kind: 'permission', behavior: 'deny', reason: 'dispatch_error' },
                options,
              ),
            );
          });
      });
    };

    client.setRequestHandler(Method.SessionRequestPermission, handleRequestPermission);

    const handleAskQuestion = async (
      params: unknown,
      meta: { id: string | number; method: string },
    ): Promise<unknown> => {
      toolIdle.noteActivity();
      const parsed = parseAskQuestionParams(params);
      if (!parsed) {
        return { outcome: { outcome: 'skipped', reason: 'invalid ask_question params' } };
      }
      const requestId = `cursor-ask:${String(meta.id)}:${++extensionSeq}`;
      const req = toAskUserQuestionRequest(requestId, parsed);
      return await new Promise<unknown>((resolve) => {
        const entry: PendingExtensionEntry = {
          kind: 'ask_user_question',
          resolve,
          settled: false,
        };
        pendingExtensions.set(requestId, entry);
        const finalize = (result: unknown) => {
          if (entry.settled) return;
          entry.settled = true;
          pendingExtensions.delete(requestId);
          resolve(result);
        };
        dispatchInteraction(req)
          .then((decision) => {
            finalize(askQuestionResponseFromDecision(decision, parsed));
          })
          .catch((e) => {
            log.error('ask_question dispatch failed', {
              requestId,
              message: (e as Error).message,
            });
            finalize({ outcome: { outcome: 'cancelled' } });
          });
      });
    };

    const handleCreatePlan = async (
      params: unknown,
      meta: { id: string | number; method: string },
    ): Promise<unknown> => {
      toolIdle.noteActivity();
      const parsed = parseCreatePlanParams(params);
      if (!parsed) {
        return { outcome: { outcome: 'rejected', reason: 'invalid create_plan params' } };
      }
      const requestId = `cursor-plan:${String(meta.id)}:${++extensionSeq}`;
      const req = toPlanReviewRequest(requestId, parsed);
      return await new Promise<unknown>((resolve) => {
        const entry: PendingExtensionEntry = {
          kind: 'plan_review',
          resolve,
          settled: false,
        };
        pendingExtensions.set(requestId, entry);
        const finalize = (result: unknown) => {
          if (entry.settled) return;
          entry.settled = true;
          pendingExtensions.delete(requestId);
          resolve(result);
        };
        dispatchInteraction(req)
          .then(async (decision) => {
            const response = createPlanResponseFromDecision(decision);
            if (
              decision.kind === 'plan_review' &&
              decision.behavior === 'allow'
            ) {
              await exitPlanModeAfterApproval();
            }
            finalize(response);
          })
          .catch((e) => {
            log.error('create_plan dispatch failed', {
              requestId,
              message: (e as Error).message,
            });
            finalize({ outcome: { outcome: 'cancelled' } });
          });
      });
    };

    const handleUpdateTodos = async (params: unknown): Promise<unknown> => {
      toolIdle.noteActivity();
      const parsed = parseUpdateTodosParams(params);
      if (!parsed) {
        return { outcome: { outcome: 'rejected', reason: 'invalid update_todos params' } };
      }
      cursorTodos = mergeCursorTodos(cursorTodos, parsed.todos, parsed.merge);
      pushAll(
        todosToUpdatePlanEvents(cursorTodos, {
          toolCallId: CURSOR_TODOS_TOOL_USE_ID,
          source: 'cursor',
        }),
      );
      return updateTodosAcceptedResponse(cursorTodos);
    };

    client.setRequestHandler(CursorMethod.AskQuestion, handleAskQuestion);
    client.setRequestHandler(CursorMethod.CreatePlan, handleCreatePlan);
    client.setRequestHandler(CursorMethod.UpdateTodos, handleUpdateTodos);

    const pushCancelledIdle = (statusText: string) => {
      pushAll([
        {
          type: 'done',
          data: { stopReason: 'cancelled', reason: 'cancelled' },
          source: 'cursor',
        },
        {
          type: 'status',
          data: {
            isRunning: false,
            status: statusText,
            ...usageTracker.snapshot(),
          },
          source: 'cursor',
        },
      ]);
      resetAcpTurn(rt);
    };

    const finalizeTurnCancel = async (optsCancel: {
      reason: 'user_abort' | 'tool_call_idle_timeout';
      errorMessage?: string;
    }): Promise<void> => {
      if (closed) return;
      const token = turnGeneration;
      if (!turnInFlight || lastFinalizedGeneration === token) return;
      // 同步收口：在任何 await 之前固定本 token，防止 B 轮抢跑后本轮再清 watchdog / 发 done。
      lastFinalizedGeneration = token;
      turnInFlight = false;
      toolIdle.clear();
      dismissAllPending(optsCancel.reason, 'deny');
      if (token !== turnGeneration) {
        log.debug('skipping finalize events; newer turn already active', {
          token,
          turnGeneration,
          reason: optsCancel.reason,
        });
        return;
      }
      if (optsCancel.errorMessage) {
        pushAll([
          {
            type: 'error',
            data: {
              message: optsCancel.errorMessage,
              isTerminal: true,
              reason: optsCancel.reason,
            },
            source: 'cursor',
          },
        ]);
      }
      pushCancelledIdle(optsCancel.reason === 'user_abort' ? 'Cancelled' : 'Timed out');
      try {
        if (sessionId) {
          await client.notify(Method.SessionCancel, { sessionId });
        }
      } catch (e) {
        log.warn('session/cancel failed', { message: (e as Error).message, reason: optsCancel.reason });
      }
    };

    /**
     * session/prompt 后台收尾。与 send() 解耦：send 在请求发出后即返回（对齐
     * Claude/Codex「accept 后靠 isTurnRunning 管 reservation」契约）；晚到的旧
     * generation 响应不得清 watchdog、改 turnInFlight 或发 done/status。
     */
    const settlePromptTurn = (
      token: number,
      promptPromise: Promise<PromptResponse>,
    ): void => {
      void (async () => {
        try {
          const response = await promptPromise;
          if (token !== turnGeneration || closed) {
            log.debug('discarding stale cursor prompt response', {
              token,
              turnGeneration,
              closed,
            });
            return;
          }
          if (lastFinalizedGeneration === token) {
            log.debug('cursor prompt response after external finalize', { token });
            return;
          }
          toolIdle.clear();
          pushAll(finishPromptTurn(response ?? { stopReason: 'end_turn' }, translateCtx));
        } catch (e) {
          if (token !== turnGeneration || closed || lastFinalizedGeneration === token) {
            log.debug('discarding stale cursor prompt error', {
              token,
              turnGeneration,
              closed,
              finalized: lastFinalizedGeneration === token,
            });
            return;
          }
          toolIdle.clear();
          pushAll(translateAcpError(e as Error, translateCtx));
        } finally {
          if (token === turnGeneration) {
            turnInFlight = false;
          }
        }
      })();
    };

    const applyInitialModelConfig = async () => {
      const modelRaw = typeof opts.model === 'string' ? opts.model.trim() : '';
      const desiredModel = toCursorProductModelId(modelRaw || mutableModel);
      const modelExplicit = opts.vendorOptions?.cursorModelExplicit === true;
      // 未选择 / 空白 model / 显式 follow：采用 ACP current，不发 set_config_option。
      // 种子默认 `auto`（New Maker 未碰 picker）也走 follow；显式选 Auto 需
      // vendorOptions.cursorModelExplicit === true（#8 / review P1）。
      const followAcpCurrent =
        opts.vendorOptions?.followAcpCurrentModel === true ||
        !modelRaw ||
        (!modelExplicit && desiredModel === CURSOR_AUTO_MODEL.id);

      if (!followAcpCurrent) {
        if (desiredModel !== mutableModel) {
          const options = await setConfigOption('model', toCursorAcpModelId(desiredModel));
          mutableModel = desiredModel;
          await applyConfigEnrichment(mutableModel, options);
        } else if (desiredModel !== CURSOR_AUTO_MODEL.id) {
          try {
            const options = await setConfigOption('model', toCursorAcpModelId(desiredModel));
            await applyConfigEnrichment(desiredModel, options);
          } catch (err) {
            log.warn('cursor refresh model config failed', {
              message: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }

      const initialEffortOpt = opts.effort ? findCursorEffortOption(latestConfigOptions) : undefined;
      const initialEffortValue =
        initialEffortOpt && opts.effort
          ? toCursorConfigEffortValue(initialEffortOpt, opts.effort)
          : null;
      if (initialEffortOpt && initialEffortValue) {
        try {
          const options = await setConfigOption(initialEffortOpt.id, initialEffortValue);
          await applyConfigEnrichment(mutableModel, options);
        } catch (err) {
          log.warn('cursor initial setEffort failed', {
            effort: opts.effort,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
      if (
        opts.fastMode !== undefined &&
        latestConfigOptions.some((o) => o.id === 'fast')
      ) {
        try {
          const options = await setConfigOption('fast', opts.fastMode ? 'true' : 'false');
          await applyConfigEnrichment(mutableModel, options);
        } catch (err) {
          log.warn('cursor initial setFastMode failed', {
            fastMode: opts.fastMode,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
      if (latestConfigOptions.some((o) => o.id === 'thinking')) {
        try {
          const options = await setConfigOption('thinking', 'true');
          await applyConfigEnrichment(mutableModel, options);
        } catch (err) {
          log.warn('cursor initial setThinkingMode failed', {
            thinkingMode: true,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    };

    // mutable vendorOptions —— host bridge / setVendorOptions 必须共享同一引用。
    // enableOrca 后 setLeadVendorOptions 靠 Object.assign 原地写入 orcaRole/workflow;
    // 若传 opts.vendorOptions 的浅拷贝，bridge registerSessionCtx 抓到的对象永远读不到
    // 运行时补丁，Lead 协同工具面会按无角色 fail-closed（与 Claude/Codex 同契约）。
    const vo: Record<string, unknown> = { ...(opts.vendorOptions ?? {}) };

    // MCP (协同工具面) 经 host 的 HTTP bridge 注入 —— ACP 消费不了 in-process
    // McpServer instance。host 未接线 / 失败时按「无 MCP」降级,不阻断会话。
    let mcpServers: unknown[] = [];
    let mcpCleanup: (() => void) | undefined;
    if (this.deps.prepareAcpMcpServers) {
      try {
        const prepared = await this.deps.prepareAcpMcpServers({
          sessionId: opts.sessionId,
          workingDir: opts.workingDir,
          vendorOptions: vo,
        });
        mcpServers = prepared.servers;
        mcpCleanup = prepared.cleanup;
      } catch (err) {
        log.warn('cursor MCP injection skipped', {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const createFreshSession = async (): Promise<void> => {
      const created = await client.request<NewSessionResponse>(Method.SessionNew, {
        cwd: opts.workingDir,
        mcpServers,
      });
      if (!created?.sessionId || typeof created.sessionId !== 'string') {
        throw new Error('cursor session/new: missing sessionId');
      }
      sessionId = created.sessionId;
      await applyModelsFromSessionPayload(created);
      await applyInitialModelConfig();
    };

    client.start();

    try {
      await client.initialize({
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          _meta: { parameterizedModelPicker: true },
        },
        clientInfo: {
          name: 'cindy',
          title: 'Cindy',
          version: '0.0.0',
        },
      });

      const resumeId =
        typeof opts.resumeSessionId === 'string' && opts.resumeSessionId.length > 0
          ? opts.resumeSessionId
          : undefined;
      /** session/load 真正成功才为 true（不是「请求了 resume」）。 */
      let resumedSuccessfully = false;

      if (resumeId) {
        suppressHistoryReplay = true;
        try {
          const loaded = await client.request<LoadSessionResponse>(Method.SessionLoad, {
            cwd: opts.workingDir,
            sessionId: resumeId,
            mcpServers,
          });
          sessionId = resumeId;
          resumedSuccessfully = true;
          await applyModelsFromSessionPayload(loaded ?? {});
          await applyInitialModelConfig();
          log.info('session loaded', {
            sessionId,
            model: mutableModel,
            permissionMode: mutablePermissionMode,
          });
        } catch (loadErr) {
          const err = loadErr as Error;
          if (
            isCursorResumeSessionNotFound(err, resumeId) &&
            opts.onInvalidResumeSession
          ) {
            let cleared = false;
            try {
              cleared = await opts.onInvalidResumeSession(resumeId);
            } catch (casErr) {
              log.error('onInvalidResumeSession threw', {
                message: casErr instanceof Error ? casErr.message : String(casErr),
              });
              cleared = false;
            }
            if (!cleared) {
              throw new Error(formatCursorInvalidResumeCasConflictMessage());
            }
            log.warn('invalid resume id cleared; creating fresh cursor session', {
              resumeId,
              evidence: err.message,
            });
            pushAll([
              {
                type: 'error',
                data: {
                  message: formatCursorInvalidResumeMessage(resumeId),
                  isTerminal: false,
                  reason: 'resume_session_not_found',
                },
                source: 'cursor',
              },
            ]);
            await createFreshSession();
          } else if (isCursorResumeSessionNotFound(err, resumeId)) {
            // 无 CAS 钩子：仍可读提示 + 新建，避免卡死在协议错。
            log.warn('invalid resume without CAS hook; creating fresh session', {
              resumeId,
              evidence: err.message,
            });
            pushAll([
              {
                type: 'error',
                data: {
                  message: formatCursorInvalidResumeMessage(resumeId),
                  isTerminal: false,
                  reason: 'resume_session_not_found',
                },
                source: 'cursor',
              },
            ]);
            await createFreshSession();
          } else {
            throw err;
          }
        } finally {
          suppressHistoryReplay = false;
        }
      } else {
        await createFreshSession();
      }

      log.info('session ready', {
        sessionId,
        model: mutableModel,
        permissionMode: mutablePermissionMode,
        planMode: mutablePlanMode,
        listedModels: this.listedModels.length,
        resumed: resumedSuccessfully,
      });

      if (mutablePlanMode) {
        try {
          await applyAcpSessionMode('plan');
        } catch (e) {
          log.warn('initial session/set_mode(plan) failed', {
            message: e instanceof Error ? e.message : String(e),
          });
        }
      }

      eventQueue.push({
        type: 'session_id',
        data: { sessionId },
        source: 'cursor',
      });
    } catch (e) {
      const err = e as Error;
      pushAll(translateAcpError(err, translateCtx));
      eventQueue.end();
      await client.close({ reason: `startSession failed: ${err.message}` });
      isolated.dispose();
      mcpCleanup?.();
      throw err;
    }

    const liveSessionClosers = this.liveSessionClosers;
    const closeSession = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      turnInFlight = false;
      lastFinalizedGeneration = turnGeneration;
      toolIdle.clear();
      dismissAllPending('session_closed', 'deny');
      await client.close({ reason: 'CursorAgentSession.close()' });
      isolated.dispose();
      mcpCleanup?.();
      eventQueue.end();
    };
    liveSessionClosers.add(closeSession);

    const handle: AgentSessionHandle = {
      get id() {
        return sessionId;
      },
      agentKind: 'cursor',
      get model() {
        return mutableModel;
      },

      async send(message: UserMessage, sendOpts?: SendOptions) {
        if (closed) throw new Error('Cursor session is closed');
        if (sendOpts?.signal?.aborted) {
          throw new Error('Cursor send cancelled before acceptance');
        }
        if (turnInFlight) {
          throw new Error('Cursor turn already in flight (sameTurnSteer not supported)');
        }

        const prompt = await userMessageToPromptBlocks(message);
        if (sendOpts?.signal?.aborted || closed) {
          throw new Error('Cursor send cancelled before acceptance');
        }
        if (prompt.length === 0) {
          throw new Error('Cursor send: empty prompt');
        }

        turnGeneration += 1;
        const token = turnGeneration;
        turnInFlight = true;
        usageTracker.beginTurn();
        resetAcpTurn(rt);
        toolIdle.clear();

        /** 本 token 仍是活跃轮：未 close、未被更新的 generation 抢占、未被 abort/watchdog finalize。 */
        const isActiveTurn = (): boolean =>
          !closed && token === turnGeneration && lastFinalizedGeneration !== token;

        // 武装态一次性消耗（与 Claude/Codex 同语义）：勾选熄灭，ACP sticky plan 保留到 create_plan 批准。
        const requestedPlanTurn = sendOpts?.planMode ?? mutablePlanMode;
        if (requestedPlanTurn) {
          if (mutablePlanMode && sendOpts?.planMode !== false) {
            mutablePlanMode = false;
            eventQueue.push({
              type: 'plan_mode_changed',
              data: { enabled: false },
              source: 'cursor',
            });
          }
          if (!acpInPlanMode) {
            try {
              await applyAcpSessionMode('plan');
            } catch (e) {
              log.warn('session/set_mode(plan) before prompt failed', {
                message: e instanceof Error ? e.message : String(e),
              });
            }
          }
        }

        // set_mode 等 preflight await 之后必须再查 active-turn：abort 可能已 finalize 本 token，
        // 此时绝不能再发 session/prompt（否则 UI 已 cancelled，上游却重跑旧请求）。
        if (!isActiveTurn() || sendOpts?.signal?.aborted) {
          if (token === turnGeneration && lastFinalizedGeneration !== token) {
            turnInFlight = false;
          }
          throw new Error('Cursor send cancelled before acceptance');
        }

        pushAll([
          {
            type: 'status',
            data: {
              isRunning: true,
              status: 'Starting...',
              ...usageTracker.snapshot(),
            },
            source: 'cursor',
          },
        ]);

        // 与 Claude/Codex 对齐：send() 只表示 accept，不等整轮 session/prompt。
        // Session 靠 isTurnRunning() 持有产品层 busy；abort/watchdog 翻 false 后即可发下一轮。
        const promptPromise = client.request<PromptResponse>(Method.SessionPrompt, {
          sessionId,
          prompt,
        });
        settlePromptTurn(token, promptPromise);
      },

      async steer(_message: UserMessage, _sendOpts?: SendOptions) {
        throw new NotSupportedError('sameTurnSteer', UNSUPPORTED.sameTurnSteer);
      },

      async abort() {
        if (closed || (!turnInFlight && pendingApprovals.size === 0 && pendingExtensions.size === 0)) {
          return;
        }
        await finalizeTurnCancel({ reason: 'user_abort' });
      },

      async close() {
        liveSessionClosers.delete(closeSession);
        await closeSession();
      },

      events(): AsyncIterable<AgentEvent> {
        return eventQueue;
      },

      getUsageSnapshot(): UsageSnapshot {
        return usageTracker.snapshot();
      },

      setInteractionResolver(resolver: InteractionResolver) {
        interactionResolver = resolver;
      },

      isTurnRunning(): boolean {
        return turnInFlight;
      },

      async setVendorOptions(patch: Record<string, unknown>) {
        // in-place 合并：prepareAcpMcpServers / bridge ctx 闭包抓的是同一 vo 引用。
        Object.assign(vo, patch);
        log.debug('setVendorOptions', { patchKeys: Object.keys(patch) });
      },

      async setModel(newModel: string) {
        if (closed) throw new Error('Cursor session is closed');
        const productId = toCursorProductModelId(newModel);
        if (productId === mutableModel) {
          const options = await setConfigOption('model', toCursorAcpModelId(productId));
          await applyConfigEnrichment(productId, options);
        } else {
          log.debug('setModel', { from: mutableModel, to: productId });
          const options = await setConfigOption('model', toCursorAcpModelId(productId));
          mutableModel = productId;
          await applyConfigEnrichment(productId, options);
        }
        // 切模后若新模型暴露 thinking 且上游非 true，强制开。
        if (latestConfigOptions.some((o) => o.id === 'thinking')) {
          const thinkingVal = readConfigOptionValue(latestConfigOptions, 'thinking');
          if (thinkingVal !== 'true') {
            try {
              const options = await setConfigOption('thinking', 'true');
              await applyConfigEnrichment(mutableModel, options);
            } catch (err) {
              log.warn('cursor setModel force thinking failed', {
                message: err instanceof Error ? err.message : String(err),
              });
            }
          }
        }
      },

      async setEffort(newEffort: Effort) {
        if (closed) throw new Error('Cursor session is closed');
        if (!findCursorEffortOption(latestConfigOptions)) {
          const refreshed = await setConfigOption('model', toCursorAcpModelId(mutableModel));
          await applyConfigEnrichment(mutableModel, refreshed);
        }
        const effortOpt = findCursorEffortOption(latestConfigOptions);
        if (!effortOpt) {
          throw new NotSupportedError('effort', {
            supported: false,
            reason: 'sdk-missing',
            message: `Cursor model ${mutableModel} does not expose effort`,
          });
        }
        // 档位拼写按模型走（xhigh ↔ extra-high、minimal ↔ none），发原样 Cindy 值会被上游拒。
        const value = toCursorConfigEffortValue(effortOpt, newEffort);
        if (!value) {
          throw new NotSupportedError('effort', {
            supported: false,
            reason: 'sdk-missing',
            message: `Cursor model ${mutableModel} does not support effort ${newEffort}`,
          });
        }
        log.debug('setEffort', { from: mutableEffort, to: newEffort, configId: effortOpt.id });
        const options = await setConfigOption(effortOpt.id, value);
        await applyConfigEnrichment(mutableModel, options);
      },

      async setFastMode(enabled: boolean) {
        if (closed) throw new Error('Cursor session is closed');
        if (!latestConfigOptions.some((o) => o.id === 'fast')) {
          const refreshed = await setConfigOption('model', toCursorAcpModelId(mutableModel));
          await applyConfigEnrichment(mutableModel, refreshed);
        }
        if (!latestConfigOptions.some((o) => o.id === 'fast')) {
          throw new NotSupportedError('fastMode', {
            supported: false,
            reason: 'sdk-missing',
            message: `Cursor model ${mutableModel} does not expose fast mode`,
          });
        }
        log.debug('setFastMode', { from: mutableFastMode, to: enabled });
        const options = await setConfigOption('fast', enabled ? 'true' : 'false');
        await applyConfigEnrichment(mutableModel, options);
      },

      getFastMode() {
        return mutableFastMode;
      },


      async setPermissionMode(newMode: PermissionMode) {
        const normalized = normalizeCursorPermissionMode(newMode);
        log.debug('setPermissionMode', { from: mutablePermissionMode, to: normalized });
        mutablePermissionMode = normalized;
        if (normalized === 'auto') {
          autoFallbackNotified = false;
        }
        dismissAllPending(
          `permission_mode:${normalized}`,
          normalized === 'bypassPermissions' ? 'allow' : 'deny',
        );
      },

      async setPlanMode(enabled: boolean) {
        if (closed) throw new Error('Cursor session is closed');
        if (mutablePlanMode === enabled) return;
        mutablePlanMode = enabled;
        log.debug('setPlanMode', { enabled });
        // turn 流式中只记账武装态；idle 时立即推 ACP mode。
        if (turnInFlight) return;
        const moreOpen =
          !enabled &&
          (mutablePermissionMode === 'auto' || mutablePermissionMode === 'bypassPermissions');
        dismissAllPending(`plan_mode_${enabled ? 'enabled' : 'disabled'}`, moreOpen ? 'allow' : 'deny');
        try {
          await applyAcpSessionMode(enabled ? 'plan' : 'agent');
        } catch (e) {
          log.warn('session/set_mode failed', {
            enabled,
            message: e instanceof Error ? e.message : String(e),
          });
          throw e;
        }
      },

      getPlanMode() {
        return mutablePlanMode;
      },
    };

    // 暴露 pid 给 e2e / 孤儿核验（不进 AgentSessionHandle 公开面）
    Object.defineProperty(handle, '_acpPid', {
      get: () => client.getPid(),
      enumerable: false,
    });

    return handle;
  }
}
