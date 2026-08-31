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
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname } from 'node:path';
import type {
  AgentEvent,
  AgentTaskStatus,
  InteractionDecision,
  InteractionRequest,
  InteractionResolver,
  UsageSnapshot,
} from '../../types/events.js';
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
import {
  collectMcpToolNameCandidates,
  looksLikeUnresolvedMcpPermission,
  mcpSessionAllowKey,
  resolveMcpTargetFromCandidates,
} from '../shared/mcp-tool-target.js';
import {
  mergeDiskAndRuntimeSkills,
  parseAvailableCommandsUpdate,
  toAgentSkillCommands,
} from './availableCommands.js';
import { scanCursorCustomizations } from './customization-scanner.js';
import {
  createCursorIsolatedConfigDir,
  readUserAccountIdentityFromEnv,
  readUserNetworkConfigFromEnv,
  type CursorModelSeed,
} from './isolatedConfig.js';
import { isCursorResumeSessionNotFound } from './invalidResume.js';
import {
  CURSOR_STREAM_DISCONNECT_REASON,
  isCursorStreamDisconnectError,
} from './streamDisconnect.js';
import {
  askQuestionResponseFromDecision,
  createPlanResponseFromDecision,
  CURSOR_TODOS_TOOL_USE_ID,
  cursorGenerateImageAcceptedResponse,
  cursorGenerateImageToEvents,
  cursorTaskAcceptedResponse,
  cursorTaskToEvents,
  inferCursorTaskStatus,
  isCursorTaskTerminalStatus,
  mergeCursorTodos,
  parseAskQuestionParams,
  parseCreatePlanParams,
  parseCursorGenerateImageParams,
  parseCursorTaskParams,
  parseUpdateTodosParams,
  preflightCursorGenerateImage,
  stopCursorTaskEvents,
  toAskUserQuestionRequest,
  todosToUpdatePlanEvents,
  toPlanReviewRequest,
  updateTodosAcceptedResponse,
  type CursorTodoItem,
} from './extensions.js';
import type {
  ListCustomizationsOptions,
  ListCustomizationsResult,
} from '../../types/customizations.js';
import type {
  AgentSkillCommand,
  ListAgentSkillsOptions,
  ListAgentSkillsResult,
} from '../../types/palette.js';
import {
  CURSOR_TOOL_CALL_IDLE_TIMEOUT_REASON,
  createToolIdleWatchdog,
  formatCursorInvalidResumeCasConflictMessage,
  formatCursorFastModeUnavailableMessage,
  formatCursorInitialModelFailedMessage,
  formatCursorInvalidResumeMessage,
  formatCursorPlanModeUnavailableMessage,
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
  { id: 'max', displayName: 'Maximum', description: 'Very high reasoning budget (model-dependent)' },
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

/** 单个模型的 `session/set_config_option` 探测上限。整轮时长 ≈ 模型数 × 本值。 */
const MODEL_PROBE_TIMEOUT_MS = 20_000;

/**
 * 建会话链路（`initialize` / `session/new` / `session/load`）单条 RPC 的上限。
 *
 * 取值偏宽:冷启动的 `cursor-agent` 要装载配置与索引,慢机器上十几秒是正常的;
 * 这条线只用来兜住「对端永远不回包」,不是性能阈值。
 */
const BOOTSTRAP_RPC_TIMEOUT_MS = 60_000;

/**
 * 让一次 ACP RPC 与「取消」和有界超时赛跑。
 *
 * `client.request` / `client.initialize` 既不认 signal 也没有自带超时,对端卡住时
 * 这一次 await 永不返回。两处后果都是「永远出不了终态」:
 *
 * - 模型探测:只在循环顶部查 `signal.aborted` 不够,IPC 立刻回了 `cancelled: true`,
 *   刷新状态却永久停在 running,后续刷新还会因全局 inflight 全部 no-op;
 * - 会话 bootstrap:首条消息已经 accepted 并显示 `Starting...`,却既不成功也不报错,
 *   直到用户手动停止任务。
 *
 * 放弃后底层 RPC 仍挂在对端,但我们不再等它:两处调用方的 finally / catch 都会
 * close client(bootstrap 还会 dispose 隔离配置目录),连着把它收掉。
 */
async function raceAcpRequest<T>(
  work: Promise<T>,
  opts: {
    signal?: AbortSignal;
    timeoutMs: number;
    label: string;
    /**
     * 取消时抛出的文案。bootstrap 传既有的 `assertBootstrapActive` 同一句 ——
     * 现在 signal 会直接切断在途 RPC，比原来「等 RPC 回来再发现已取消」更早，
     * 但用户与日志看到的终态文案不该因此改变。
     */
    abortMessage?: string;
  },
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const { signal } = opts;
  const abortError = () => new Error(opts.abortMessage ?? `cursor ${opts.label} aborted`);
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`cursor ${opts.label} timed out after ${opts.timeoutMs}ms`)),
          opts.timeoutMs,
        );
        timer.unref?.();
        if (!signal) return;
        if (signal.aborted) {
          reject(abortError());
          return;
        }
        onAbort = () => reject(abortError());
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}

export class CursorAgent extends BaseAgent {
  readonly kind = 'cursor' as const;
  readonly capabilities: Capabilities;

  /** 跨会话缓存最近一次上报的目录（含 set_config_option 丰富后的 effort/fast）。 */
  private listedModels: CursorListedModel[] = [cursorAutoModelFallback()];

  /** 仍存活的会话 close 钩子 — dispose() 时 drain，防孤儿。 */
  private readonly liveSessionClosers = new Set<() => Promise<void>>();

  /**
   * ACP available_commands_update 按 Cindy business sessionId 隔离。
   * listAgentSkills 与磁盘扫盘合并时读这里；关闭会话时清空，避免串会话。
   */
  private readonly runtimeCommandsBySessionId = new Map<string, AgentSkillCommand[]>();

  constructor(deps: AgentDeps) {
    super(deps);
    this.capabilities = this.buildCapabilities(CAPABILITIES);
  }

  /**
   * ChatInput `/` palette 的 agent-skill：扫 ~/.agents/skills + ~/.cursor/skills
   * （及项目同名目录），再与当前会话 ACP available_commands_update 按名合并。
   * 无 sessionId 时仍返回磁盘 skill（新建草稿也能看见 /to-tickets）。
   */
  override async listAgentSkills(opts: ListAgentSkillsOptions): Promise<ListAgentSkillsResult> {
    void opts.forceReload;
    const { items, errors } = await scanCursorCustomizations({
      workingDirs: opts.workingDir ? [opts.workingDir] : [],
    });
    const disk: AgentSkillCommand[] = items
      .filter((it) => it.kind === 'skill' && it.enabled !== false)
      .map((it) => ({
        kind: 'agent-skill' as const,
        name: it.name,
        description: it.description,
        source: 'skill' as const,
        path: it.absolutePath,
        scope: (it.scope === 'repo' ? 'repo' : 'user') as 'user' | 'repo',
        enabled: it.enabled ?? true,
      }));

    const sessionId = typeof opts.sessionId === 'string' ? opts.sessionId.trim() : '';
    const runtime = sessionId ? (this.runtimeCommandsBySessionId.get(sessionId) ?? []) : [];
    const out: ListAgentSkillsResult = {
      skills: mergeDiskAndRuntimeSkills(disk, runtime),
    };
    if (errors.length > 0) out.errors = errors;
    return out;
  }

  /** SkillHub：与 listAgentSkills 同源扫盘，不 spawn cursor-agent。 */
  override async listCustomizations(
    opts: ListCustomizationsOptions,
  ): Promise<ListCustomizationsResult> {
    return scanCursorCustomizations(opts);
  }

  private setRuntimeCommands(sessionId: string | undefined, skills: AgentSkillCommand[]): void {
    if (!sessionId) return;
    this.runtimeCommandsBySessionId.set(sessionId, skills);
  }

  private clearRuntimeCommands(sessionId: string | undefined): void {
    if (!sessionId) return;
    this.runtimeCommandsBySessionId.delete(sessionId);
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
    /** 每探完一个模型后回调(含当前模型);用于设置页「已探 n / 总数」进度。 */
    onProgress?: (done: number, total: number) => void;
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
      networkConfigReader: this.deps.networkConfigReader ?? readUserNetworkConfigFromEnv,
      accountIdentityReader: this.deps.accountIdentityReader ?? readUserAccountIdentityFromEnv,
      expectedIdentity: authState.identity,
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
    // 这两条与逐模型探测同样要赛跑:它们卡住的话取消同样打不断,
    // `startCursorModelRefresh` 的全局 inflight 永不清空，后续刷新全部 no-op。
    const raceDiscovery = { ...(opts.signal ? { signal: opts.signal } : {}) };
    try {
      await raceAcpRequest(
        client.initialize({
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            // 不声明就拿不到参数化 picker：模型 id 会带死参数、effort 选项整个消失。
            _meta: { parameterizedModelPicker: true },
          },
          clientInfo: { name: 'cindy', title: 'Cindy', version: '0.0.0' },
        }),
        { ...raceDiscovery, timeoutMs: BOOTSTRAP_RPC_TIMEOUT_MS, label: 'discovery initialize' },
      );
      const created = await raceAcpRequest(
        client.request<NewSessionResponse>(Method.SessionNew, {
          cwd: opts.workingDir,
          mcpServers: [],
        }),
        { ...raceDiscovery, timeoutMs: BOOTSTRAP_RPC_TIMEOUT_MS, label: 'discovery session/new' },
      );
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
      const total = this.listedModels.length;
      let done = 0;
      for (const model of this.listedModels) {
        if (opts.signal?.aborted) break;
        try {
          const result = await raceAcpRequest(
            client.request<SetConfigOptionResult>(Method.SessionSetConfigOption, {
              sessionId,
              configId: 'model',
              value: toCursorAcpModelId(model.id),
            }),
            {
              ...(opts.signal ? { signal: opts.signal } : {}),
              timeoutMs: MODEL_PROBE_TIMEOUT_MS,
              label: 'model probe',
            },
          );
          enrichCursorModelFromConfigOptions(
            this.listedModels,
            model.id,
            parseAcpConfigOptions(result?.configOptions),
          );
        } catch (err) {
          // 取消是用户意图，不是探测失败：立刻收尾，别再报一条 warn 也别走完进度。
          if (opts.signal?.aborted) break;
          // 单个模型探测失败不该毁掉整轮：该模型保持「无档位」，其余照常。
          log.warn('discovery model probe failed', {
            model: model.id,
            message: err instanceof Error ? err.message : String(err),
          });
        }
        done += 1;
        try {
          opts.onProgress?.(done, total);
        } catch {
          // 进度回调失败不影响探测本身。
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
    const startSessionStartedAt = Date.now();
    // ADR: 不消费 userPrompt / makerMemoryEnabled / runtimeConfig.systemPrompt。
    // 与 Claude Code 对齐：scope 中带 business session id，host logger 才能路由到
    // sessions/<id>/<date>.ndjson。
    const sid = opts.sessionId ?? '';
    const log = this.deps.logger.child(sid ? `s:${sid}/cursor-agent` : 'cursor-agent');

    const eventQueue: AsyncQueue<AgentEvent> = createAsyncQueue();
    const startupEvents: AgentEvent[] = [];
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
    let bootstrapReady = false;
    let bootstrapError: Error | null = null;
    let handleReturnMs = 0;
    const bootstrapAbortController = new AbortController();
    let resolveBootstrapReady!: () => void;
    let rejectBootstrapReady!: (reason?: unknown) => void;
    const bootstrapReadyPromise = new Promise<void>((resolve, reject) => {
      resolveBootstrapReady = resolve;
      rejectBootstrapReady = reject;
    });
    // The promise is an intentionally non-public observability seam for tests
    // and diagnostics. Callers use normal session events, never this property.
    bootstrapReadyPromise.catch(() => undefined);
    let turnInFlight = false;
    /**
     * Per-turn generation token。每次 send 递增；abort / watchdog / prompt 收尾
     * 只有持有当前 active token 才能改状态、清 watchdog、发 done/status。
     * 晚到的旧轮响应一律丢弃，避免污染下一轮。
     */
    let turnGeneration = 0;
    /** 已由 abort / tool-idle 推过终态的 generation；同 token 的 prompt 收尾跳过二次 done/error。 */
    let lastFinalizedGeneration = 0;
    /**
     * #45 接的是 SessionPrompt 的 JSON-RPC reject 路径。但 Cursor 上游断流还有另一种
     * 形态：断流文案（如 `RetriableError: [canceled] http/2 stream closed …`）经
     * `agent_message_chunk` 文本 delta 流进来，prompt 又以正常 `end_turn` resolve --
     * 于是走 settlePromptTurn 的 success 分支，文案被当成 assistant 正文落库，且不发
     * error 事件，既有自愈判据（isInterruptedTurnError）根本不触发。
     *
     * 这里在 delta 层拦截：命中断流签名就记下文案、不推 text 事件（不污染 textBuf /
     * 不广播给 register 落库），settlePromptTurn 的 success 分支据此把正常 done 升级
     * 成 `cursor-stream-disconnect` 终态 error，复用既有自愈。见 streamDisconnect.ts。
     */
    let streamDisconnectText: string | null = null;
    function extractAgentMessageChunkText(params: unknown): string | null {
      if (!isRecord(params)) return null;
      const update = (params as { update?: unknown }).update;
      if (!isRecord(update) || update.sessionUpdate !== 'agent_message_chunk') return null;
      const content = update.content;
      if (!isRecord(content) || content.type !== 'text' || typeof content.text !== 'string') {
        return null;
      }
      return content.text;
    }
    let sessionId = '';
    let mutablePermissionMode = normalizeCursorPermissionMode(opts.permissionMode);
    /** UI 武装态：send 消耗后熄灭；ACP 侧 sticky plan 另用 acpInPlanMode。 */
    let mutablePlanMode = opts.planMode === true;
    /** 上游 session 当前是否处于 plan mode（session/set_mode）。 */
    let acpInPlanMode = opts.planMode === true;
    let mutableModel = toCursorProductModelId(opts.model || CURSOR_AUTO_MODEL.id);
    let desiredModel = mutableModel;
    let modelSelectionChanged = false;
    let desiredConfigRevision = 0;
    let appliedConfigRevision = -1;
    let mutableEffort: Effort | undefined = opts.effort;
    let desiredEffort: Effort | undefined = opts.effort;
    let mutableFastMode = opts.fastMode === true;
    let desiredFastMode: boolean | undefined = opts.fastMode;
    // Thinking 非可选：有 ACP thinking option 时始终 true（对齐 Codex/CC，忽略 start false）。
    let mutableThinkingMode = true;
    let latestConfigOptions: AcpConfigOption[] = [];
    let spawnInitializeMs = 0;
    let sessionMs = 0;
    let sessionMethod: 'session/new' | 'session/load' = 'session/new';
    let initialConfigMs = 0;
    /** 初始档位实际发出的 set_config_option 次数；0 = 预写 / 目录记录全命中。 */
    let initialConfigRequests = 0;
    const sessionAllowKeys = new Set<string>();
    /** 本会话冻入的 MCP server 名（prepareAcpMcpServers 快照），供审批归属。 */
    const registeredMcpServerNames = new Set<string>();
    let autoFallbackNotified = false;
    /** session/load 回放历史期间为 true — Cindy 自有存储渲染，跳过上游回放。 */
    let suppressHistoryReplay = false;
    /** cursor/update_todos merge 用的会话内快照。 */
    let cursorTodos: CursorTodoItem[] = [];
    /** cursor/task：已发过 tool_use 的 toolCallId，避免重复卡。 */
    const emittedCursorTaskToolUseIds = new Set<string>();
    /** 仍标记为 running 的 Cursor 子任务（键一律 toolCallId；取消/关闭时 stopped 收口）。 */
    const runningCursorTasks = new Map<string, { toolCallId: string; title?: string }>();
    /** toolCallId → 已达终态；忽略晚到 running / 重复终态（#49）。 */
    const terminalCursorTasks = new Map<string, AgentTaskStatus>();
    /** cursor/generate_image：已成功物化/推送的 toolCallId（幂等；仅成功后写入）。 */
    const emittedCursorGenerateImageIds = new Set<string>();
    /** 进行中的 generate_image（同 toolCallId 合并到同一 Promise）。 */
    const inflightCursorGenerateImages = new Map<string, Promise<unknown>>();
    let extensionSeq = 0;
    let pendingPrompt: {
      token: number;
      prompt: ContentBlock[];
      requestedPlanTurn: boolean;
    } | null = null;
    let isolated: ReturnType<typeof createCursorIsolatedConfigDir> | null = null;
    /** 鉴权门拿到的 email；隔离目录预置账号身份用。未通过鉴权门前保持 undefined。 */
    let expectedAccountIdentity: string | undefined;

    const pushAll = (events: AgentEvent[]): void => {
      for (const ev of events) eventQueue.push(ev);
    };

    /**
     * 跟随 ACP 当前模型（不下发 set_config_option）：用户没选 / 种子默认 auto 且非
     * 显式选择时成立。预写与初始下发共用这一判据 —— 预写若绕过它，等于替用户钦点
     * 模型，还会盖掉上游自己记住的 sticky 模型。
     */
    const shouldFollowAcpCurrentModel = (): boolean => {
      const modelRaw = typeof opts.model === 'string' ? opts.model.trim() : '';
      const modelExplicit = opts.vendorOptions?.cursorModelExplicit === true;
      return (
        opts.vendorOptions?.followAcpCurrentModel === true ||
        (!modelSelectionChanged &&
          (!modelRaw || (!modelExplicit && desiredModel === CURSOR_AUTO_MODEL.id)))
      );
    };

    /** 实际预写进 cli-config 的 ACP model id；供「预写没生效」的判据用。 */
    let seededAcpModelId: string | undefined;
    const buildModelSeed = (): CursorModelSeed | undefined => {
      if (shouldFollowAcpCurrentModel()) return undefined;
      const parameters: Record<string, string> = {};
      // 只预写取值空间固定的档位：fast 恒 true/false，effort 的 id 与拼写随模型变。
      if (desiredFastMode !== undefined) parameters.fast = desiredFastMode ? 'true' : 'false';
      seededAcpModelId = toCursorAcpModelId(desiredModel);
      return { modelId: seededAcpModelId, parameters };
    };

    const getIsolatedConfig = (): ReturnType<typeof createCursorIsolatedConfigDir> => {
      if (isolated) return isolated;
      const userDataPath = this.deps.runtimeConfig.userDataPath;
      if (!userDataPath || !userDataPath.trim()) {
        throw new Error('CursorAgent requires runtimeConfig.userDataPath (host must inject; no HOME fallback)');
      }
      isolated = createCursorIsolatedConfigDir(process.env, {
        stableKey: opts.sessionId,
        userDataPath,
        networkConfigReader: this.deps.networkConfigReader ?? readUserNetworkConfigFromEnv,
        accountIdentityReader: this.deps.accountIdentityReader ?? readUserAccountIdentityFromEnv,
        expectedIdentity: expectedAccountIdentity,
        modelSeed: buildModelSeed(),
      });
      return isolated;
    };

    const client = new AcpClient({
      createTransport: () => {
        const injected = opts.vendorOptions?.createAcpTransport;
        if (typeof injected === 'function') {
          return injected() as Transport;
        }
        return resolveCreateTransport(opts, this.deps, getIsolatedConfig().env)();
      },
      logger: log,
      onTransportError: (err) => {
        log.error('transport error', { message: err.message });
        // 优先注销 bridge ctx，再收口会话——避免 activeSessions 已空但
        // ?session= 仍可达（review P0）。
        void (async () => {
          try {
            mcpCleanup?.();
          } catch (cleanupErr) {
            log.warn('mcpCleanup during transport error failed', {
              message: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
            });
          } finally {
            mcpCleanup = undefined;
          }
          if (!closed && bootstrapReady) {
            pushAll(translateAcpError(err, translateCtx));
          }
          if (!closed) {
            await closeSession();
          } else if (!resourcesClosed) {
            await cleanupResources('transport_error');
          }
        })();
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
          reason: CURSOR_TOOL_CALL_IDLE_TIMEOUT_REASON,
          errorMessage: formatCursorToolIdleMessage(idleMs),
        });
      },
    });

    const requestSetConfigOption = async (
      configId: string,
      value: string,
    ): Promise<AcpConfigOption[]> => {
      const result = await client.request<SetConfigOptionResult>(Method.SessionSetConfigOption, {
        sessionId,
        configId,
        value,
      });
      return parseAcpConfigOptions(result?.configOptions);
    };

    const setConfigOption = async (
      configId: string,
      value: string,
    ): Promise<AcpConfigOption[]> => {
      const options = await requestSetConfigOption(configId, value);
      if (options.length > 0) latestConfigOptions = options;
      return options.length > 0 ? options : latestConfigOptions;
    };

    // 会话内只同步自身状态（effort / fast / thinking），不把读回的 config 合并进
    // 模型目录、也不再广播目录变更（spec #21/#27：目录唯一写入方是设置页刷新）。
    // ACP 的 effort / fast 是 per-model，切模型即重置成目标模型自己的记录值，所以
    // 每次 set_config_option 回包后仍必须按读回值刷新会话状态，否则会话与上游错位。
    const applyConfigSessionState = (options: AcpConfigOption[]) => {
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
    };

    const applyModelsFromSessionPayload = async (
      payload: NewSessionResponse | LoadSessionResponse,
    ) => {
      const parsed = parseCursorModelsState(payload.models);
      if (parsed) {
        mutableModel = parsed.currentModelId;
      } else {
        log.warn('cursor session models missing or empty; keeping Auto fallback');
      }
      latestConfigOptions = parseAcpConfigOptions(payload.configOptions);
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
      // 命令清单不是历史内容：session/load 回放抑制期间也要收下，否则 resume 丢 palette。
      const parsedCommands = parseAvailableCommandsUpdate(params);
      if (parsedCommands) {
        this.setRuntimeCommands(opts.sessionId, toAgentSkillCommands(parsedCommands));
      }
      if (suppressHistoryReplay) {
        // 上游 session/load 会回放历史；Cindy 用自有存储渲染，这里整段丢弃。
        return;
      }
      // 断流文案形态：上游把错误塞进 agent_message_chunk 文本流而非 JSON-RPC reject
      // （#45 盲区）。命中则记下文案、不推 text 事件 -- 否则文案会被当成 assistant
      // 正文落库、且正常 done 收尾使自愈判据不触发。settlePromptTurn 据此升级为
      // cursor-stream-disconnect 终态 error。
      const chunkText = extractAgentMessageChunkText(params);
      if (chunkText !== null && isCursorStreamDisconnectError(chunkText)) {
        streamDisconnectText = streamDisconnectText ?? chunkText;
        log.warn('cursor stream disconnect detected via agent_message_chunk text', {
          sessionId,
          turnGeneration,
          text: chunkText,
        });
        return;
      }
      trackToolActivityFromUpdate(params);
      pushAll(translateSessionUpdate(params, translateCtx));
    });

    // ── dispatchInteraction + pendingApprovals (Codex 同款 dismiss 模式) ──
    interface PendingEntry {
      resolve: (result: RequestPermissionResult) => void;
      settled: boolean;
      /** prompt-each-time：切 Full/宽松档不得批量 allow。 */
      forcePrompt?: boolean;
    }
    interface PendingExtensionEntry {
      kind: 'ask_user_question' | 'plan_review';
      resolve: (result: unknown) => void;
      settled: boolean;
    }
    const pendingApprovals = new Map<string, PendingEntry>();
    const pendingExtensions = new Map<string, PendingExtensionEntry>();
    let permissionSeq = 0;

    /**
     * 人机交互（审批 / 提问 / 计划审阅）进行中 → 暂停 tool-idle 计时。
     *
     * 上游在等人：期间没有 session/update 是正常的，不该消耗 tool-call 不活动的
     * 空闲配额（否则用户在审批卡上想太久，看门狗会误杀整轮 turn，连待决审批一起
     * dismiss）。语义与 Codex 的 upstream-idle「ball 不在上游不计配额」同源。
     */
    const syncToolIdleSuspend = (): void => {
      const active = pendingApprovals.size + pendingExtensions.size > 0;
      if (active) {
        if (toolIdle.suspendedDepth() === 0) toolIdle.suspend();
      } else if (toolIdle.suspendedDepth() > 0) {
        toolIdle.resume();
      }
    };

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
          // forcePrompt(prompt-each-time) 不接受「切到 Full」批量放行。
          const effective: 'allow' | 'deny' =
            resolveAs === 'allow' && entry.forcePrompt === true ? 'deny' : resolveAs;
          const result: RequestPermissionResult =
            effective === 'allow'
              ? { outcome: { outcome: 'selected', optionId: 'allow-once' } }
              : cancelledPermissionResult();
          entry.resolve(result);
          eventQueue.push({
            type: 'interaction_dismissed',
            data: { requestId, reason, resolvedAs: effective },
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
          // 扩展类待决（plan_review / ask_user_question）**一律取消，绝不批准**。
          //
          // 唯二会传 `resolveAs='allow'` 的调用方是权限档切换与退出计划模式；把它们
          // 当成「同意这份计划」是偷换了用户动作 —— 他改的是文件/命令权限档，或者只是
          // 退出计划模式，从没看过、更没批准过这份计划，而 accepted 会让 agent 直接照着
          // 干。计划批准必须是用户在计划卡上的显式一次决定。
          //
          // 取消不会丢东西：这一轮仍在等，agent 收到 cancelled 后按既有路径收口。
          entry.resolve({ outcome: { outcome: 'cancelled' } });
          eventQueue.push({
            type: 'interaction_dismissed',
            // resolvedAs 报**实际**结果，不报调用方的意图：否则日志会显示
            // 「allow」而 agent 实际收到 cancelled。
            data: { requestId, reason, resolvedAs: 'deny' },
            source: 'cursor',
          });
        }
      }
      // dismiss 直接删 entry、不经过 finalize，这里统一重算暂停状态。
      syncToolIdleSuspend();
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

    const classifyMcpApprovalPolicy = (
      toolName: string,
      toolCall: Partial<Record<string, unknown>>,
      toolInput: Record<string, unknown>,
    ): {
      policy: 'auto-approve' | 'prompt' | 'prompt-each-time' | null;
      target: { serverName: string; toolName: string } | null;
    } => {
      const classifier = this.deps.getMcpToolApprovalPolicy;
      if (!classifier || registeredMcpServerNames.size === 0) {
        return { policy: null, target: null };
      }
      const toolCallRecord = isRecord(toolCall) ? toolCall : {};
      // 只采 ACP 权威字段；禁止从业务 rawInput 推断身份。
      const target = resolveMcpTargetFromCandidates(
        collectMcpToolNameCandidates(toolName, toolCallRecord, toolInput),
        registeredMcpServerNames,
      );
      if (!target) {
        // 泛化 / 缺失 / 冲突身份：一律逐次确认，绝不能静默放行。
        if (looksLikeUnresolvedMcpPermission(toolName, toolCallRecord)) {
          return { policy: 'prompt-each-time', target: null };
        }
        return { policy: null, target: null };
      }
      try {
        const policy = classifier({
          serverName: target.serverName,
          toolName: target.toolName,
          toolParams: toolInput,
        });
        if (policy === 'auto-approve' || policy === 'prompt' || policy === 'prompt-each-time') {
          if (policy === 'auto-approve') {
            log.debug('mcp tool auto-approved by host policy', {
              serverName: target.serverName,
              toolName: target.toolName,
            });
          }
          return { policy, target };
        }
        log.error('invalid MCP approval policy -> prompt each time', {
          serverName: target.serverName,
          policy,
        });
      } catch (error) {
        log.error('MCP approval policy threw -> prompt each time', {
          serverName: target.serverName,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return { policy: 'prompt-each-time', target };
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
      const options = Array.isArray(permParams.options) ? permParams.options : [];
      const toolName = toolNameFromAcpToolCall(toolCall);
      const toolInput = toolInputFromAcpToolCall(toolCall);
      const toolCallRecord = isRecord(toolCall) ? toolCall : {};

      // MCP policy 必须先于 Full/Auto：只有 auto-approve 可静默；prompt /
      // prompt-each-time 一律进 UI（与 Codex 同契约）。
      const { policy: mcpPolicy, target: mcpTarget } = classifyMcpApprovalPolicy(
        toolName,
        toolCallRecord,
        toolInput,
      );
      if (mcpPolicy === 'auto-approve') {
        return toRequestPermissionResult(
          { kind: 'permission', behavior: 'allow' },
          options,
        );
      }
      const forcePromptEachTime = mcpPolicy === 'prompt-each-time';
      const forceUiForMcp = mcpPolicy === 'prompt' || forcePromptEachTime;
      const sessionAllowKey = mcpTarget
        ? mcpSessionAllowKey(mcpTarget.serverName, mcpTarget.toolName)
        : sessionAllowKeyFromToolCall(toolCall);

      // Full access：非 MCP / 已 auto-approve 的在上面处理；MCP prompt* 不得静默。
      if (mutablePermissionMode === 'bypassPermissions' && !forceUiForMcp) {
        return toRequestPermissionResult(
          { kind: 'permission', behavior: 'allow' },
          options,
        );
      }

      // 本会话已批准的指纹（prompt-each-time 禁止复用会话记忆）
      if (!forcePromptEachTime && sessionAllowKeys.has(sessionAllowKey)) {
        return toRequestPermissionResult(
          { kind: 'permission', behavior: 'allow' },
          options,
        );
      }

      // Auto: MCP prompt/prompt-each-time 跳过分类器静默放行，强制弹卡。
      if (!forceUiForMcp && mutablePermissionMode === 'auto') {
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
                  // 分类器据此判定目标是否在工作区内：不给根它只能按路径形状保守裁决。
                  workspaceRoot: opts.workingDir,
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
        // prompt-each-time：不下发「本会话不再问」建议
        suggestions: forcePromptEachTime ? undefined : sessionSuggestionsFor(sessionAllowKey),
      });

      return await new Promise<RequestPermissionResult>((resolve) => {
        const entry: PendingEntry = {
          resolve,
          settled: false,
          forcePrompt: forcePromptEachTime,
        };
        pendingApprovals.set(requestId, entry);
        syncToolIdleSuspend();
        const finalize = (result: RequestPermissionResult) => {
          if (entry.settled) return;
          entry.settled = true;
          pendingApprovals.delete(requestId);
          syncToolIdleSuspend();
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
              !forcePromptEachTime &&
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
        syncToolIdleSuspend();
        const finalize = (result: unknown) => {
          if (entry.settled) return;
          entry.settled = true;
          pendingExtensions.delete(requestId);
          syncToolIdleSuspend();
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
        syncToolIdleSuspend();
        const finalize = (result: unknown) => {
          if (entry.settled) return;
          entry.settled = true;
          pendingExtensions.delete(requestId);
          syncToolIdleSuspend();
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

    const stopRunningCursorTasks = (reason: string): void => {
      if (runningCursorTasks.size === 0) return;
      for (const [toolCallId] of runningCursorTasks) {
        terminalCursorTasks.set(toolCallId, 'stopped');
      }
      pushAll(stopCursorTaskEvents(runningCursorTasks, reason));
      runningCursorTasks.clear();
    };

    const clearRunningCursorTask = (toolCallId: string, agentId?: string): void => {
      runningCursorTasks.delete(toolCallId);
      // 兼容旧键（曾用 agentId ?? toolCallId）：同时清别名，避免 close 误标 stopped。
      if (agentId) runningCursorTasks.delete(agentId);
      const displayId = agentId?.trim();
      if (displayId && displayId !== toolCallId) {
        runningCursorTasks.delete(displayId);
      }
    };

    const applyCursorTaskNotification = (params: unknown): unknown => {
      toolIdle.noteActivity();
      const parsed = parseCursorTaskParams(params);
      if (!parsed) {
        log.warn('cursor/task invalid params', {
          preview:
            typeof params === 'object' && params
              ? Object.keys(params as object).slice(0, 8)
              : typeof params,
        });
        return { outcome: { outcome: 'rejected', reason: 'invalid cursor/task params' } };
      }
      const status = inferCursorTaskStatus(parsed);
      const priorTerminal = terminalCursorTasks.get(parsed.toolCallId);
      if (priorTerminal) {
        log.warn('cursor/task ignoring stale or duplicate transition', {
          toolCallId: parsed.toolCallId,
          priorTerminal,
          attempted: status,
          agentId: parsed.agentId,
        });
        return cursorTaskAcceptedResponse(parsed);
      }

      const already = emittedCursorTaskToolUseIds.has(parsed.toolCallId);
      pushAll(
        cursorTaskToEvents(parsed, {
          alreadyEmittedToolUse: already,
          source: 'cursor',
        }),
      );
      emittedCursorTaskToolUseIds.add(parsed.toolCallId);

      if (isCursorTaskTerminalStatus(status)) {
        terminalCursorTasks.set(parsed.toolCallId, status);
        clearRunningCursorTask(parsed.toolCallId, parsed.agentId);
      } else if (status === 'running') {
        runningCursorTasks.set(parsed.toolCallId, {
          toolCallId: parsed.toolCallId,
          title: parsed.description.trim() || undefined,
        });
      }
      return cursorTaskAcceptedResponse(parsed);
    };

    const pushCursorGenerateImageFailure = (toolCallId: string, reason: string): void => {
      pushAll([
        {
          type: 'tool_use',
          source: 'cursor',
          data: { toolUseId: toolCallId, toolName: 'imagegen', input: {} },
        },
        {
          type: 'tool_result_full',
          source: 'cursor',
          data: {
            toolUseId: toolCallId,
            fullText: JSON.stringify({ ok: false, kind: 'generation', error: reason }),
            isError: true,
          },
        },
        {
          type: 'tool_result',
          source: 'cursor',
          data: { summary: reason, toolUseIds: [toolCallId] },
        },
      ]);
    };

    const applyCursorGenerateImage = async (params: unknown): Promise<unknown> => {
      toolIdle.noteActivity();
      const parsed = parseCursorGenerateImageParams(params);
      if (!parsed) {
        log.warn('cursor/generate_image invalid params');
        return { outcome: { outcome: 'rejected', reason: 'invalid cursor/generate_image params' } };
      }
      if (emittedCursorGenerateImageIds.has(parsed.toolCallId)) {
        log.warn('cursor/generate_image duplicate toolCallId ignored', {
          toolCallId: parsed.toolCallId,
        });
        // 幂等：已成功物化过则不再推事件；对 Cursor 仍 ACK generated。
        return cursorGenerateImageAcceptedResponse(parsed);
      }
      const inflight = inflightCursorGenerateImages.get(parsed.toolCallId);
      if (inflight) return inflight;

      const work = (async (): Promise<unknown> => {
        const allowedRoots = [opts.workingDir, tmpdir()].filter(
          (r): r is string => typeof r === 'string' && r.trim().length > 0,
        );
        const rejectReason = preflightCursorGenerateImage(parsed, { allowedRoots });
        if (rejectReason) {
          log.warn('cursor/generate_image rejected by preflight', {
            toolCallId: parsed.toolCallId,
            reason: rejectReason,
          });
          return { outcome: { outcome: 'rejected', reason: rejectReason } };
        }

        const materialize = this.deps.materializeCursorGeneratedImage;
        if (materialize) {
          const sourceUrl = parsed.filePath?.startsWith('data:')
            ? parsed.filePath
            : parsed.imageData
              ? parsed.imageData.startsWith('data:')
                ? parsed.imageData
                : `data:image/png;base64,${parsed.imageData}`
              : undefined;
          const sourcePath =
            parsed.filePath && !parsed.filePath.startsWith('data:') && !/^https?:/i.test(parsed.filePath)
              ? parsed.filePath
              : undefined;
          let mat: Awaited<ReturnType<NonNullable<typeof materialize>>>;
          try {
            mat = await materialize({
              sessionId,
              workingDir: opts.workingDir,
              ...(sourcePath ? { path: sourcePath } : {}),
              ...(sourceUrl ? { url: sourceUrl } : {}),
            });
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            log.warn('cursor/generate_image materialize threw', {
              toolCallId: parsed.toolCallId,
              reason,
            });
            pushCursorGenerateImageFailure(parsed.toolCallId, reason);
            return { outcome: { outcome: 'rejected', reason } };
          }
          if (!mat.ok) {
            log.warn('cursor/generate_image materialize rejected', {
              toolCallId: parsed.toolCallId,
              reason: mat.reason,
            });
            pushCursorGenerateImageFailure(parsed.toolCallId, mat.reason);
            return { outcome: { outcome: 'rejected', reason: mat.reason } };
          }
          // 成功后才 latch + 推已入仓地址（不再把任意本机 path 交给下游）。
          emittedCursorGenerateImageIds.add(parsed.toolCallId);
          pushAll([
            {
              type: 'image',
              source: 'cursor',
              data: {
                kind: 'generation',
                blockId: parsed.toolCallId,
                status: 'completed',
                url: mat.url,
                ...(parsed.description ? { revisedPrompt: parsed.description } : {}),
              },
            },
          ]);
          return {
            outcome: {
              outcome: 'generated' as const,
              filePath: mat.url,
            },
          };
        }

        // 无 host 钩子（单测）：预检通过后推 image 事件；生产 desktop 必须注入钩子。
        const events = cursorGenerateImageToEvents(parsed, { source: 'cursor' });
        if (events.length === 0) {
          log.warn('cursor/generate_image missing media', { toolCallId: parsed.toolCallId });
          return { outcome: { outcome: 'rejected', reason: 'missing filePath/imageData' } };
        }
        emittedCursorGenerateImageIds.add(parsed.toolCallId);
        pushAll(events);
        return cursorGenerateImageAcceptedResponse(parsed);
      })();

      inflightCursorGenerateImages.set(parsed.toolCallId, work);
      try {
        return await work;
      } finally {
        inflightCursorGenerateImages.delete(parsed.toolCallId);
      }
    };

    client.setRequestHandler(CursorMethod.AskQuestion, handleAskQuestion);
    client.setRequestHandler(CursorMethod.CreatePlan, handleCreatePlan);
    client.setRequestHandler(CursorMethod.UpdateTodos, handleUpdateTodos);
    client.setRequestHandler(CursorMethod.Task, async (params) => applyCursorTaskNotification(params));
    client.setRequestHandler(CursorMethod.GenerateImage, async (params) =>
      applyCursorGenerateImage(params),
    );
    client.onNotification(CursorMethod.Task, (params) => {
      applyCursorTaskNotification(params);
    });
    client.onNotification(CursorMethod.GenerateImage, (params) => {
      void applyCursorGenerateImage(params);
    });

    const pushCancelledIdle = (statusText: string) => {
      stopRunningCursorTasks('cancelled');
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
      reason: 'user_abort' | typeof CURSOR_TOOL_CALL_IDLE_TIMEOUT_REASON;
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
          // 断流文案形态：prompt 以正常 end_turn resolve，但断流文案已走文本流进来。
          // 不走 finishPromptTurn（会把残留 textBuf 当正文吐 + 正常 done）；升级为
          // cursor-stream-disconnect 终态 error，复用既有 isInterruptedTurnError 自愈。
          if (streamDisconnectText) {
            const text = streamDisconnectText;
            streamDisconnectText = null;
            pushAll(
              translateAcpError(new Error(text), translateCtx, {
                reason: CURSOR_STREAM_DISCONNECT_REASON,
              }),
            );
          } else {
            pushAll(finishPromptTurn(response ?? { stopReason: 'end_turn' }, translateCtx));
          }
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
          const reason = isCursorStreamDisconnectError(e)
            ? CURSOR_STREAM_DISCONNECT_REASON
            : undefined;
          pushAll(translateAcpError(e as Error, translateCtx, { reason }));
        } finally {
          if (token === turnGeneration) {
            turnInFlight = false;
          }
        }
      })();
    };

    const cloneConfigOptions = (options: AcpConfigOption[]): AcpConfigOption[] =>
      options.map((option) => ({
        ...option,
        options: option.options.map((choice) => ({ ...choice })),
      }));

    /**
     * 同模型时能否直接进入档位下发：desired 要设的档位，回包必须已暴露对应
     * option。缺一就退回同模型 refresh —— 否则会踩下面「没有 fast option 就只
     * warn 不发」的分支，比每次 refresh 更糟。
     */
    const hasCompleteOptionSnapshot = (options: readonly AcpConfigOption[]): boolean => {
      if (desiredEffort !== undefined && !findCursorEffortOption(options)) return false;
      if (desiredFastMode !== undefined && !options.some((o) => o.id === 'fast')) return false;
      return true;
    };

    const applyInitialModelConfig = async () => {
      // 未选择 / 空白 model / 显式 follow：采用 ACP current，不发 set_config_option。
      // 种子默认 `auto`（New Maker 未碰 picker）也走 follow；显式选 Auto 需
      // vendorOptions.cursorModelExplicit === true（#8 / review P1）。
      const followAcpCurrent = shouldFollowAcpCurrentModel();

      if (!followAcpCurrent) {
        // 模型设不上不得毁掉整个会话：codex / claude 起会话都不校验模型，且同函数
        // 下面的 effort / fast / thinking 失败也只 warn。抛出去会让该 session 每次
        // 重建都在同一处失败（Orca lead 尤其致命：worker 汇报永远投不进来）。
        const switching = desiredModel !== mutableModel;
        if (
          switching &&
          sessionMethod === 'session/new' &&
          seededAcpModelId === toCursorAcpModelId(desiredModel)
        ) {
          // 预写在回包里没生效 = 上游配置 schema 漂了。行为上仍由下面的下发兜住，
          // 但省往返的收益已经没了，留一条可检索的痕迹。
          log.warn('cursor model preseed did not take', {
            desiredModel,
            currentModel: mutableModel,
          });
        }
        // 同模型 refresh 只在快照缺档位时才做：预写命中后 session/new 已带齐
        // model / effort / fast，再发一次纯属白付一个往返。
        if (switching || (desiredModel !== CURSOR_AUTO_MODEL.id && !hasCompleteOptionSnapshot(latestConfigOptions))) {
          try {
            initialConfigRequests += 1;
            const options = await setConfigOption('model', toCursorAcpModelId(desiredModel));
            if (switching) mutableModel = desiredModel;
            applyConfigSessionState(options);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            log.warn('cursor initial setModel failed', { model: desiredModel, switching, message });
            // 只有「用户要的模型没换上」才提示；同模型 refresh 失败无行为差异。
            if (switching) {
              eventQueue.push({
                type: 'error',
                data: {
                  message: formatCursorInitialModelFailedMessage(desiredModel, mutableModel, message),
                  isTerminal: false,
                  reason: 'initial_model_unavailable',
                },
                source: 'cursor',
              });
            }
          }
        }
      }

      // All initial option decisions must use the same post-model snapshot. The
      // responses below are full snapshots and may arrive out of order.
      const baseOptions = cloneConfigOptions(latestConfigOptions);
      // 档位可能一条都不用下发（预写命中 / resume 目录已记住），那时下面的合并块
      // 不会跑；会话状态得先按快照对齐，否则 effort / fast 停在 opts 的初值。
      applyConfigSessionState(baseOptions);
      type InitialConfigRequest = {
        kind: 'effort' | 'fast' | 'thinking';
        configId: string;
        value: string;
      };
      const requests: InitialConfigRequest[] = [];

      const initialEffortOpt = desiredEffort ? findCursorEffortOption(baseOptions) : undefined;
      const initialEffortValue =
        initialEffortOpt && desiredEffort
          ? toCursorConfigEffortValue(initialEffortOpt, desiredEffort)
          : null;
      // 已经是目标值就不发。effort 的取值拼写按模型自报（xhigh / extra-high），
      // 故比对必须在 toCursorConfigEffortValue 映射后的空间做。
      if (initialEffortOpt && initialEffortValue && initialEffortOpt.currentValue !== initialEffortValue) {
        requests.push({
          kind: 'effort',
          configId: initialEffortOpt.id,
          value: initialEffortValue,
        });
      }

      const fastOption = baseOptions.find((o) => o.id === 'fast');
      if (desiredFastMode !== undefined && fastOption) {
        const desiredFastValue = desiredFastMode ? 'true' : 'false';
        if (fastOption.currentValue !== desiredFastValue) {
          requests.push({
            kind: 'fast',
            configId: 'fast',
            value: desiredFastValue,
          });
        }
      } else if (desiredFastMode !== undefined) {
        // 初始 Fast 被请求但目标模型当前未暴露 fast option -> 无法下发。
        // 隔离 config dir 下 session/new 的当前模型常是 `default`(Auto)，其
        // configOptions 不含 fast/effort/thinking，需先 set_config_option('model',…)
        // 才出现；走 followAcpCurrent 时此分支恒成立，Fast 永远不下发。
        log.warn('cursor initial setFastMode skipped: no fast option exposed', {
          model: mutableModel,
          fastMode: desiredFastMode,
          followAcpCurrent,
        });
        // 只有「用户明确要开 Fast 却没开成」才提示 —— 关 Fast 没开成无行为差异。
        // 光打 warn 不够：保存的自动化与 UI 都还显示 Fast 已开启，用户会以为在加速跑。
        // 与初始模型切换失败同一处置（非终态 error，不打断会话）。
        if (desiredFastMode === true) {
          eventQueue.push({
            type: 'error',
            data: {
              message: formatCursorFastModeUnavailableMessage(mutableModel),
              isTerminal: false,
              reason: 'fast_mode_unavailable',
            },
            source: 'cursor',
          });
        }
      }

      // 恒开语义不变：只跳过「已经是 true」，报 false 照发（不信任 false 方向）。
      const thinkingOption = baseOptions.find((o) => o.id === 'thinking');
      if (thinkingOption && thinkingOption.currentValue !== 'true') {
        requests.push({
          kind: 'thinking',
          configId: 'thinking',
          value: 'true',
        });
      }

      initialConfigRequests += requests.length;
      let settleSequence = 0;
      const settleOrder = new Map<number, number>();
      const results = await Promise.allSettled(
        requests.map((request, index) =>
          requestSetConfigOption(request.configId, request.value).finally(() => {
            settleOrder.set(index, ++settleSequence);
          }),
        ),
      );

      const targetedIds = new Set(requests.map((request) => request.configId));
      const mergedOptions = cloneConfigOptions(baseOptions);
      const successfulResponses: Array<{
        options: AcpConfigOption[];
        settleOrder: number;
      }> = [];

      const replaceOption = (option: AcpConfigOption): void => {
        const index = mergedOptions.findIndex((current) => current.id === option.id);
        const replacement = {
          ...option,
          options: option.options.map((choice) => ({ ...choice })),
        };
        if (index >= 0) {
          mergedOptions[index] = replacement;
        } else {
          mergedOptions.push(replacement);
        }
      };

      for (let index = 0; index < results.length; index += 1) {
        const result = results[index];
        if (result.status === 'fulfilled' && result.value.length > 0) {
          successfulResponses.push({
            options: result.value,
            settleOrder: settleOrder.get(index) ?? Number.MAX_SAFE_INTEGER,
          });
          const ownOption = result.value.find((option) => option.id === requests[index]!.configId);
          if (ownOption) replaceOption(ownOption);
        }
      }

      // Preserve the latest full snapshot for options not touched by this batch,
      // while each requested option is sourced only from its own response.
      successfulResponses.sort((a, b) => a.settleOrder - b.settleOrder);
      const lastResponse = successfulResponses[successfulResponses.length - 1];
      if (lastResponse) {
        for (const option of lastResponse.options) {
          if (!targetedIds.has(option.id)) replaceOption(option);
        }
      }

      if (requests.length > 0) {
        latestConfigOptions = mergedOptions;
        applyConfigSessionState(mergedOptions);
      }

      for (let index = 0; index < results.length; index += 1) {
        const result = results[index];
        if (result.status !== 'rejected') continue;
        const request = requests[index]!;
        const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
        if (request.kind === 'effort') {
          log.warn('cursor initial setEffort failed', {
            effort: desiredEffort,
            message,
          });
        } else if (request.kind === 'fast') {
          log.warn('cursor initial setFastMode failed', {
            fastMode: desiredFastMode,
            message,
          });
        } else {
          log.warn('cursor initial setThinkingMode failed', {
            thinkingMode: true,
            message,
          });
        }
      }
    };

    // 只包住初始配置整段，不包含 auth gate / MCP 注入 / session/new|load。
    // 后续流水线化后这里仍然记录整段墙钟耗时。
    const applyInitialModelConfigWithTiming = async () => {
      const startedAt = Date.now();
      const revisionAtStart = desiredConfigRevision;
      try {
        await applyInitialModelConfig();
      } finally {
        initialConfigMs = Date.now() - startedAt;
        appliedConfigRevision = revisionAtStart;
      }
    };

    const applyLatestInitialModelConfig = async (): Promise<void> => {
      let attempts = 0;
      while (appliedConfigRevision !== desiredConfigRevision && attempts < 4) {
        attempts += 1;
        await applyInitialModelConfigWithTiming();
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

    let resourcesClosed = false;
    const cleanupResources = async (reason: string): Promise<void> => {
      if (resourcesClosed) return;
      resourcesClosed = true;
      await client.close({ reason });
      isolated?.dispose();
      isolated = null;
      mcpCleanup?.();
      mcpCleanup = undefined;
      eventQueue.end();
    };

    const liveSessionClosers = this.liveSessionClosers;
    const closeSession = async (): Promise<void> => {
      if (closed && resourcesClosed) return;
      closed = true;
      liveSessionClosers.delete(closeSession);
      bootstrapAbortController.abort();
      pendingPrompt = null;
      turnInFlight = false;
      lastFinalizedGeneration = turnGeneration;
      toolIdle.clear();
      stopRunningCursorTasks('session_closed');
      dismissAllPending('session_closed', 'deny');
      this.clearRuntimeCommands(opts.sessionId);
      await cleanupResources('CursorAgentSession.close()');
    };
    liveSessionClosers.add(closeSession);

    const createFreshSession = async (): Promise<void> => {
      const startedAt = Date.now();
      let created: NewSessionResponse;
      try {
        created = await raceAcpRequest(
          client.request<NewSessionResponse>(Method.SessionNew, {
            cwd: opts.workingDir,
            mcpServers,
          }),
          {
            signal: bootstrapAbortController.signal,
            timeoutMs: BOOTSTRAP_RPC_TIMEOUT_MS,
            label: 'session/new',
            abortMessage: 'Cursor session bootstrap cancelled',
          },
        );
      } finally {
        sessionMs = Date.now() - startedAt;
        sessionMethod = 'session/new';
      }
      if (!created?.sessionId || typeof created.sessionId !== 'string') {
        throw new Error('cursor session/new: missing sessionId');
      }
      sessionId = created.sessionId;
      await applyModelsFromSessionPayload(created);
      await applyInitialModelConfigWithTiming();
    };

    const dispatchPendingPrompt = async (): Promise<void> => {
      const pending = pendingPrompt;
      if (!pending || !bootstrapReady || closed || bootstrapError) return;
      pendingPrompt = null;
      if (
        pending.token !== turnGeneration ||
        lastFinalizedGeneration === pending.token
      ) {
        return;
      }
      if (pending.requestedPlanTurn && !acpInPlanMode) {
        try {
          await applyAcpSessionMode('plan');
        } catch (e) {
          // 同 send 路径：武装了 Plan 就不能降级按普通模式发。这里已经脱离 send 的
          // 调用栈（bootstrap 完成后的 fire-and-forget 派发），只能以终态错误收口。
          const reason = e instanceof Error ? e.message : String(e);
          log.warn('session/set_mode(plan) before queued prompt failed; dropping the turn', {
            message: reason,
          });
          if (pending.token === turnGeneration && lastFinalizedGeneration !== pending.token) {
            turnInFlight = false;
            lastFinalizedGeneration = pending.token;
          }
          // 武装态还给用户：这条排队消息没发出去，Plan 勾选不该白白熄灭。
          if (!mutablePlanMode) {
            mutablePlanMode = true;
            eventQueue.push({
              type: 'plan_mode_changed',
              data: { enabled: true },
              source: 'cursor',
            });
          }
          pushAll(
            translateAcpError(
              new Error(formatCursorPlanModeUnavailableMessage(reason)),
              translateCtx,
              { reason: 'plan_mode_unavailable' },
            ),
          );
          return;
        }
      }
      if (
        closed ||
        bootstrapError ||
        pending.token !== turnGeneration ||
        lastFinalizedGeneration === pending.token ||
        pendingPrompt
      ) {
        return;
      }
      try {
        settlePromptTurn(
          pending.token,
          client.request<PromptResponse>(Method.SessionPrompt, {
            sessionId,
            prompt: pending.prompt,
          }),
        );
      } catch (e) {
        if (pending.token === turnGeneration && lastFinalizedGeneration !== pending.token) {
          turnInFlight = false;
          pushAll(translateAcpError(e as Error, translateCtx));
        }
      }
    };

    const bootstrap = async (): Promise<void> => {
      const assertBootstrapActive = (): void => {
        if (closed || bootstrapAbortController.signal.aborted) {
          throw new Error('Cursor session bootstrap cancelled');
        }
      };

      try {
        assertBootstrapActive();
        // 未授权不产生任何副作用 —— 放在 MCP 准备、隔离配置目录与 spawn 之前。
        // Renderer 的发送门禁挡不住这条路径:定时任务 / Orca Worker / 会话恢复
        // 都直接调 startSession,用户也可能在建会话与后台 bootstrap 之间登出。
        // 语义见 base-agent 的 AgentNotAuthenticatedError 约定。
        const authState = await this.deps.auth.getState();
        assertBootstrapActive();
        if (!authState.authenticated) {
          throw new AgentNotAuthenticatedError(
            'cursor',
            `cursor not authenticated: ${authState.errorReason ?? 'no_credentials'}`,
          );
        }
        expectedAccountIdentity = authState.identity;
        if (this.deps.prepareAcpMcpServers) {
          try {
            const prepared = await this.deps.prepareAcpMcpServers({
              sessionId: opts.sessionId,
              workingDir: opts.workingDir,
              vendorOptions: vo,
            });
            if (closed || bootstrapAbortController.signal.aborted) {
              prepared.cleanup?.();
              rejectBootstrapReady(new Error('Cursor session bootstrap cancelled'));
              return;
            }
            mcpServers = prepared.servers;
            mcpCleanup = prepared.cleanup;
            registeredMcpServerNames.clear();
            for (const server of prepared.servers) {
              if (
                server &&
                typeof server === 'object' &&
                'name' in server &&
                typeof (server as { name: unknown }).name === 'string' &&
                (server as { name: string }).name
              ) {
                registeredMcpServerNames.add((server as { name: string }).name);
              }
            }
          } catch (err) {
            log.warn('cursor MCP injection skipped', {
              message: err instanceof Error ? err.message : String(err),
            });
          }
        }
        assertBootstrapActive();

        const spawnInitializeStartedAt = Date.now();
        client.start();
        // 版本不兼容 / 内部死锁的 cursor-agent 可能起来了却不回 initialize。没有这条
        // 上限,bootstrap 永远进不了终态,而首条消息已经 accepted 并显示 Starting...。
        const initResult = await raceAcpRequest(
          client.initialize({
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
          }),
          {
            signal: bootstrapAbortController.signal,
            timeoutMs: BOOTSTRAP_RPC_TIMEOUT_MS,
            label: 'initialize',
            abortMessage: 'Cursor session bootstrap cancelled',
          },
        );
        spawnInitializeMs = Date.now() - spawnInitializeStartedAt;
        assertBootstrapActive();

        // 不支持 HTTP MCP 时清空注入并 cleanup，纯聊天仍可建会话（AC ⑥ / review P1）。
        const mcpCaps = initResult?.agentCapabilities?.mcpCapabilities;
        const httpMcpSupported =
          !mcpCaps ||
          mcpCaps.http === true ||
          mcpCaps.http === undefined;
        if (!httpMcpSupported && mcpServers.length > 0) {
          log.warn('cursor ACP lacks mcpCapabilities.http; dropping MCP injection', {
            mcpCapabilities: mcpCaps,
            droppedServers: mcpServers.length,
          });
          try {
            mcpCleanup?.();
          } finally {
            mcpCleanup = undefined;
          }
          mcpServers = [];
          registeredMcpServerNames.clear();
        }

        const resumeId =
          typeof opts.resumeSessionId === 'string' && opts.resumeSessionId.length > 0
            ? opts.resumeSessionId
            : undefined;
        /** session/load 真正成功才为 true（不是「请求了 resume」）。 */
        let resumedSuccessfully = false;

        if (resumeId) {
          suppressHistoryReplay = true;
          try {
            const loadStartedAt = Date.now();
            let loaded: LoadSessionResponse;
            try {
              loaded = await raceAcpRequest(
                client.request<LoadSessionResponse>(Method.SessionLoad, {
                  cwd: opts.workingDir,
                  sessionId: resumeId,
                  mcpServers,
                }),
                {
                  signal: bootstrapAbortController.signal,
                  timeoutMs: BOOTSTRAP_RPC_TIMEOUT_MS,
                  label: 'session/load',
                  abortMessage: 'Cursor session bootstrap cancelled',
                },
              );
            } finally {
              sessionMs = Date.now() - loadStartedAt;
              sessionMethod = 'session/load';
            }
            sessionId = resumeId;
            resumedSuccessfully = true;
            await applyModelsFromSessionPayload(loaded ?? {});
            await applyInitialModelConfigWithTiming();
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
        await applyLatestInitialModelConfig();
        assertBootstrapActive();

        log.info('session ready', {
          sessionId,
          model: mutableModel,
          effort: desiredEffort ?? 'default',
          workDir: opts.workingDir,
          resume: opts.resumeSessionId ?? 'new',
          handleReturnMs,
          spawnInitializeMs,
          sessionMs,
          sessionMethod,
          initialConfigMs,
          initialConfigRequests,
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
          data: sessionId,
          source: 'cursor',
        });
        bootstrapReady = true;
        resolveBootstrapReady();
        void dispatchPendingPrompt();
      } catch (e) {
        const err = e as Error;
        if (closed || bootstrapAbortController.signal.aborted) {
          rejectBootstrapReady(err);
          await cleanupResources(`CursorAgentSession bootstrap cancelled: ${err.message}`);
          return;
        }
        bootstrapError = err;
        pendingPrompt = null;
        turnInFlight = false;
        lastFinalizedGeneration = turnGeneration;
        closed = true;
        // 未授权是可操作的终态:打上 reason 让上层按「去设置里登录」引导,
        // 而不是把它混进泛化的 ACP 失败里靠文案猜。
        pushAll(
          translateAcpError(
            err,
            translateCtx,
            err instanceof AgentNotAuthenticatedError ? { reason: 'not_authenticated' } : undefined,
          ),
        );
        rejectBootstrapReady(err);
        await cleanupResources(`CursorAgentSession bootstrap failed: ${err.message}`);
        liveSessionClosers.delete(closeSession);
      }
    };

    const handle: AgentSessionHandle = {
      get id() {
        return sessionId || '<pending>';
      },
      agentKind: 'cursor',
      get model() {
        return mutableModel;
      },
      startupEvents,
      bootstrapReady: bootstrapReadyPromise,

      async send(message: UserMessage, sendOpts?: SendOptions) {
        if (bootstrapError) throw bootstrapError;
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
        streamDisconnectText = null;
        toolIdle.clear();

        /** 本 token 仍是活跃轮：未 close、未被更新的 generation 抢占、未被 abort/watchdog finalize。 */
        const isActiveTurn = (): boolean =>
          !closed && token === turnGeneration && lastFinalizedGeneration !== token;

        // 武装态一次性消耗（与 Claude/Codex 同语义）：勾选熄灭，ACP sticky plan 保留到 create_plan 批准。
        const requestedPlanTurn = sendOpts?.planMode ?? mutablePlanMode;
        /** 本次是否消耗了 UI 武装态；发送失败时要还回去。 */
        let consumedArmedPlan = false;
        if (requestedPlanTurn) {
          if (mutablePlanMode && sendOpts?.planMode !== false) {
            mutablePlanMode = false;
            consumedArmedPlan = true;
            eventQueue.push({
              type: 'plan_mode_changed',
              data: { enabled: false },
              source: 'cursor',
            });
          }
          if (bootstrapReady && !acpInPlanMode) {
            try {
              await applyAcpSessionMode('plan');
            } catch (e) {
              // 用户显式要的是「先给一份可复核的计划」。切不过去就**不能**降级按普通
              // agent 模式发出去——那等于直接改文件 / 执行命令。失败必须可见。
              const reason = e instanceof Error ? e.message : String(e);
              log.warn('session/set_mode(plan) before prompt failed; refusing to send', {
                message: reason,
              });
              if (consumedArmedPlan) {
                // 这一轮没发出去，武装态还给用户：能重试，也能显式关掉计划模式再发。
                mutablePlanMode = true;
                eventQueue.push({
                  type: 'plan_mode_changed',
                  data: { enabled: true },
                  source: 'cursor',
                });
              }
              if (token === turnGeneration && lastFinalizedGeneration !== token) {
                turnInFlight = false;
              }
              throw new Error(formatCursorPlanModeUnavailableMessage(reason));
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

        if (!bootstrapReady) {
          pendingPrompt = { token, prompt, requestedPlanTurn };
          return;
        }

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
        if (closed) return;
        if (!bootstrapReady) {
          bootstrapAbortController.abort();
          if (turnInFlight || pendingApprovals.size > 0 || pendingExtensions.size > 0) {
            await finalizeTurnCancel({ reason: 'user_abort' });
          }
          await closeSession();
          return;
        }
        if (!turnInFlight && pendingApprovals.size === 0 && pendingExtensions.size === 0) {
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
        desiredModel = productId;
        modelSelectionChanged = true;
        desiredConfigRevision += 1;
        if (!bootstrapReady) {
          mutableModel = productId;
          return;
        }
        // 切模型前的会话 Fast 快照：ACP 的 fast 是 per-model 持久，set model 回包
        // 会被目标模型的记录值覆盖（见下方 applyConfigSessionState 同步 mutableFastMode），
        // 补发要用切模型**前**用户拨的值，不是被回包覆盖后的值。
        const desiredFastBeforeSwitch = mutableFastMode ? 'true' : 'false';
        if (productId === mutableModel) {
          const options = await setConfigOption('model', toCursorAcpModelId(productId));
          applyConfigSessionState(options);
        } else {
          log.debug('setModel', { from: mutableModel, to: productId });
          const options = await setConfigOption('model', toCursorAcpModelId(productId));
          mutableModel = productId;
          applyConfigSessionState(options);
        }
        // 切模后若新模型暴露 thinking 且上游非 true，强制开。
        if (latestConfigOptions.some((o) => o.id === 'thinking')) {
          const thinkingVal = readConfigOptionValue(latestConfigOptions, 'thinking');
          if (thinkingVal !== 'true') {
            try {
              const options = await setConfigOption('thinking', 'true');
              applyConfigSessionState(options);
            } catch (err) {
              log.warn('cursor setModel force thinking failed', {
                message: err instanceof Error ? err.message : String(err),
              });
            }
          }
        }
        // 切模后若新模型暴露 fast option，按切模型前的会话 Fast 值补发一次（与
        // thinking 补发对称）。Cursor 的 ACP fast 是 per-model 持久的：切模型会被
        // 目标模型重置成它自己的记录值，不补发则 ACP 侧实际是目标模型的旧记录，
        // 而 UI/DB 仍显示用户拨的会话态。目标模型不暴露 fast 时不发也不抛。
        if (latestConfigOptions.some((o) => o.id === 'fast')) {
          const fastVal = readConfigOptionValue(latestConfigOptions, 'fast');
          if (fastVal !== desiredFastBeforeSwitch) {
            try {
              const options = await setConfigOption('fast', desiredFastBeforeSwitch);
              applyConfigSessionState(options);
            } catch (err) {
              log.warn('cursor setModel reissue fast failed', {
                message: err instanceof Error ? err.message : String(err),
              });
            }
          }
        }
      },

      async setEffort(newEffort: Effort) {
        if (closed) throw new Error('Cursor session is closed');
        desiredEffort = newEffort;
        desiredConfigRevision += 1;
        if (!bootstrapReady) {
          mutableEffort = newEffort;
          return;
        }
        if (!findCursorEffortOption(latestConfigOptions)) {
          const refreshed = await setConfigOption('model', toCursorAcpModelId(mutableModel));
          applyConfigSessionState(refreshed);
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
        applyConfigSessionState(options);
      },

      async setFastMode(enabled: boolean) {
        if (closed) throw new Error('Cursor session is closed');
        desiredFastMode = enabled;
        desiredConfigRevision += 1;
        if (!bootstrapReady) {
          mutableFastMode = enabled;
          return;
        }
        if (!latestConfigOptions.some((o) => o.id === 'fast')) {
          const refreshed = await setConfigOption('model', toCursorAcpModelId(mutableModel));
          applyConfigSessionState(refreshed);
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
        applyConfigSessionState(options);
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
        if (!bootstrapReady) return;
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

    // Keep all auth/config-dir/transport work off the startSession stack. A
    // microtask is intentional: even an AuthAdapter or injected transport
    // whose first operation is synchronous must not delay handle creation.
    queueMicrotask(() => {
      handleReturnMs = Date.now() - startSessionStartedAt;
      log.info('session handle returned', {
        handleReturnMs,
        sessionId: handle.id,
      });
      void bootstrap();
    });

    return handle;
  }
}
