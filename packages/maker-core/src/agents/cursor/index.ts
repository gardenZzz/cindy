/**
 * CursorAgent — 经官方 ACP (`cursor-agent acp`) 接入的薄子类。
 *
 * T2: initialize → session/new → session/prompt → 文本流式。
 * T3: tool_call* 翻译 + session/request_permission → InteractionRequest；
 *     Ask / Auto / Full 全部在 Cindy 客户端策略层实现。
 * T4: session/new 模型目录上报 host；effort / fast 经 session/set_config_option。
 *
 * 按 ADR:
 *  - 不注入任何 Cindy system prompt / makerMemory / userPrompt
 *  - usage 预接 PromptResponse.usage + usage_update, 上游无数据时保持「无数据」
 *  - initialize 声明 `_meta.parameterizedModelPicker: true`
 *  - allow-always 实测为机器级 → 永不下发, 会话记忆留在 Cindy
 */

import {
  BaseAgent,
  type AgentDeps,
  type AgentSessionHandle,
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
import type { Effort, PermissionMode, UserContentBlock, UserMessage } from '../../types/common.js';
import { createAsyncQueue, type AsyncQueue } from '../shared/async-queue.js';
import { UsageTracker } from '../shared/usage-tracker.js';
import {
  AcpClient,
  ACP_PROTOCOL_VERSION,
  autoClassifierAllowsKind,
  cancelledPermissionResult,
  createAcpStdioTransport,
  finishPromptTurn,
  Method,
  newAcpRuntime,
  permissionToolCall,
  resetAcpTurn,
  sessionAllowKeyFromSuggestion,
  sessionAllowKeyFromToolCall,
  toInteractionRequest,
  toRequestPermissionResult,
  translateAcpError,
  translateSessionUpdate,
  type AcpConfigOption,
  type AcpTranslateContext,
  type ContentBlock,
  type NewSessionResponse,
  type PromptResponse,
  type RequestPermissionParams,
  type RequestPermissionResult,
  type SetConfigOptionResult,
} from '../acp/index.js';
import { createCursorIsolatedConfigDir } from './isolatedConfig.js';
import {
  cursorAutoModelFallback,
  enrichCursorModelFromConfigOptions,
  parseAcpConfigOptions,
  parseCursorModelsState,
  readConfigOptionValue,
  toCursorAcpModelId,
  toCursorProductModelId,
  type CursorListedModel,
} from './models.js';

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
  planMode: {
    supported: false as const,
    reason: 'not-implemented' as const,
    message: 'Cursor plan/ask 模式留给后续票',
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
  planMode: UNSUPPORTED.planMode,
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

function userMessageToPromptBlocks(message: UserMessage): ContentBlock[] {
  const content = message.content;
  if (typeof content === 'string') {
    return content.length > 0 ? [{ type: 'text', text: content }] : [];
  }
  const blocks: ContentBlock[] = [];
  for (const block of content as UserContentBlock[]) {
    if (block.type === 'text' && block.text.length > 0) {
      blocks.push({ type: 'text', text: block.text });
      continue;
    }
    if (block.type === 'image') {
      blocks.push({ type: 'text', text: `[image: ${block.path}]` });
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

export class CursorAgent extends BaseAgent {
  readonly kind = 'cursor' as const;
  readonly capabilities: Capabilities;

  /** 跨会话缓存最近一次上报的目录（含 set_config_option 丰富后的 effort/fast）。 */
  private listedModels: CursorListedModel[] = [cursorAutoModelFallback()];

  constructor(deps: AgentDeps) {
    super(deps);
    this.capabilities = this.buildCapabilities(CAPABILITIES);
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

  async startSession(opts: StartSessionOptions): Promise<AgentSessionHandle> {
    // ADR: 不消费 userPrompt / makerMemoryEnabled / runtimeConfig.systemPrompt。
    const log = this.deps.logger.child('cursor-agent');
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
    let sessionId = '';
    let mutablePermissionMode = normalizeCursorPermissionMode(opts.permissionMode);
    let mutableModel = toCursorProductModelId(opts.model || CURSOR_AUTO_MODEL.id);
    let mutableEffort: Effort | undefined = opts.effort;
    let mutableFastMode = opts.fastMode === true;
    let latestConfigOptions: AcpConfigOption[] = [];
    const sessionAllowKeys = new Set<string>();
    let autoFallbackNotified = false;

    const isolated = createCursorIsolatedConfigDir(process.env);

    const pushAll = (events: AgentEvent[]): void => {
      for (const ev of events) eventQueue.push(ev);
    };

    const client = new AcpClient({
      createTransport: () =>
        createAcpStdioTransport({
          binaryPath: this.deps.binaryPath,
          args: ['acp'],
          cwd: opts.workingDir,
          env: isolated.env,
        }),
      logger: log,
      onTransportError: (err) => {
        log.error('transport error', { message: err.message });
        if (!closed) {
          pushAll(translateAcpError(err, translateCtx));
          eventQueue.end();
        }
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
      const effortVal = readConfigOptionValue(options, 'effort');
      if (
        effortVal === 'low' ||
        effortVal === 'medium' ||
        effortVal === 'high' ||
        effortVal === 'xhigh' ||
        effortVal === 'max'
      ) {
        mutableEffort = effortVal;
      }
      const fastVal = readConfigOptionValue(options, 'fast');
      if (fastVal === 'true' || fastVal === 'false') {
        mutableFastMode = fastVal === 'true';
      }
      await this.publishListedModels(productModelId);
    };

    client.onNotification(Method.SessionUpdate, (params) => {
      pushAll(translateSessionUpdate(params, translateCtx));
    });

    // ── dispatchInteraction + pendingApprovals (Codex 同款 dismiss 模式) ──
    interface PendingEntry {
      resolve: (result: RequestPermissionResult) => void;
      settled: boolean;
    }
    const pendingApprovals = new Map<string, PendingEntry>();
    let permissionSeq = 0;

    const sessionSuggestionsFor = (sessionAllowKey: string) =>
      this.createSessionPermissionUpdates({
        type: 'cursorSessionApproval',
        sessionAllowKey,
      });

    function defaultPermissionDecision(reason: string): InteractionDecision {
      return { kind: 'permission', behavior: 'deny', reason };
    }

    async function dispatchInteraction(req: InteractionRequest): Promise<InteractionDecision> {
      if (!interactionResolver) {
        log.warn('dispatchInteraction without resolver — defaulting to deny', {
          kind: req.kind,
          requestId: req.requestId,
        });
        return defaultPermissionDecision('no_interaction_resolver');
      }
      try {
        return await interactionResolver(req);
      } catch (e) {
        log.error('interactionResolver threw → deny', {
          kind: req.kind,
          message: (e as Error).message,
        });
        return defaultPermissionDecision('interaction_resolver_error');
      }
    }

    function dismissAllPending(reason: string, resolveAs: 'allow' | 'deny'): void {
      if (pendingApprovals.size === 0) return;
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

    const notifyAutoClassifierUnavailable = () => {
      if (autoFallbackNotified) return;
      autoFallbackNotified = true;
      const notify = this.deps.onAutoPermissionClassifierUnavailable;
      if (!notify) return;
      try {
        notify({
          sessionId: opts.sessionId ?? sessionId,
          agentKind: 'cursor',
          status: 500,
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
      const requestId = `cursor-perm:${String(meta.id)}:${++permissionSeq}`;
      const permParams = (
        isRecord(params) ? params : { sessionId: '', toolCall: {}, options: [] }
      ) as unknown as RequestPermissionParams;
      const toolCall = permissionToolCall(permParams);
      const sessionAllowKey = sessionAllowKeyFromToolCall(toolCall);
      const options = Array.isArray(permParams.options) ? permParams.options : [];

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

      // Auto: 客户端 kind 分类器
      if (mutablePermissionMode === 'auto') {
        try {
          if (autoClassifierAllowsKind(toolCall.kind)) {
            return toRequestPermissionResult(
              { kind: 'permission', behavior: 'allow' },
              options,
            );
          }
        } catch (e) {
          log.warn('auto classifier failed — falling back to ask', {
            message: (e as Error).message,
          });
          notifyAutoClassifierUnavailable();
          mutablePermissionMode = 'ask';
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

      const created = await client.request<NewSessionResponse>(Method.SessionNew, {
        cwd: opts.workingDir,
        mcpServers: [],
      });
      if (!created?.sessionId || typeof created.sessionId !== 'string') {
        throw new Error('cursor session/new: missing sessionId');
      }
      sessionId = created.sessionId;

      const parsed = parseCursorModelsState(created.models);
      if (parsed) {
        // 保留上一轮 enrich 过的 effort/fast 元数据（同 id 合并）。
        const prevById = new Map(this.listedModels.map((m) => [m.id, m]));
        this.listedModels = parsed.models.map((m) => {
          const prev = prevById.get(m.id);
          return prev
            ? {
                ...m,
                efforts: prev.efforts.length > 0 ? prev.efforts : m.efforts,
                defaultEffort: prev.defaultEffort ?? m.defaultEffort,
                supportsFastMode: prev.supportsFastMode ?? m.supportsFastMode,
                contextWindow: prev.contextWindow !== 200_000 ? prev.contextWindow : m.contextWindow,
              }
            : m;
        });
        // 会话默认跟随 cursor 侧当前模型；创建参数若显式指定则下面再 set。
        mutableModel = parsed.currentModelId;
      } else {
        log.warn('cursor session/new models missing or empty; keeping Auto fallback');
      }
      latestConfigOptions = parseAcpConfigOptions(created.configOptions);
      await this.publishListedModels(mutableModel);

      // 创建参数模型与 cursor 当前不一致 → 立刻 set_config_option。
      const desiredModel = toCursorProductModelId(opts.model || mutableModel);
      if (desiredModel !== mutableModel) {
        const options = await setConfigOption('model', toCursorAcpModelId(desiredModel));
        mutableModel = desiredModel;
        await applyConfigEnrichment(mutableModel, options);
      } else if (desiredModel !== CURSOR_AUTO_MODEL.id) {
        // 已是目标模型时仍拉一次 config，拿 effort/fast 选项。
        try {
          const options = await setConfigOption('model', toCursorAcpModelId(desiredModel));
          await applyConfigEnrichment(desiredModel, options);
        } catch (err) {
          log.warn('cursor refresh model config failed', {
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (opts.effort && latestConfigOptions.some((o) => o.id === 'effort')) {
        try {
          const options = await setConfigOption('effort', opts.effort);
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

      log.info('session created', {
        sessionId,
        model: mutableModel,
        permissionMode: mutablePermissionMode,
        listedModels: this.listedModels.length,
      });

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
      throw err;
    }

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

        const prompt = userMessageToPromptBlocks(message);
        if (prompt.length === 0) {
          throw new Error('Cursor send: empty prompt');
        }

        turnInFlight = true;
        usageTracker.beginTurn();
        resetAcpTurn(rt);
        pushAll([
          {
            type: 'status',
            data: {
              isRunning: true,
              text: 'Starting...',
              ...usageTracker.snapshot(),
            },
            source: 'cursor',
          },
        ]);

        try {
          const response = await client.request<PromptResponse>(Method.SessionPrompt, {
            sessionId,
            prompt,
          });
          pushAll(finishPromptTurn(response ?? { stopReason: 'end_turn' }, translateCtx));
        } catch (e) {
          const err = e as Error;
          pushAll(translateAcpError(err, translateCtx));
        } finally {
          turnInFlight = false;
        }
      },

      async steer(_message: UserMessage, _sendOpts?: SendOptions) {
        throw new NotSupportedError('sameTurnSteer', UNSUPPORTED.sameTurnSteer);
      },

      async abort() {
        if (closed || !turnInFlight) return;
        dismissAllPending('session_aborted', 'deny');
        try {
          await client.notify(Method.SessionCancel, { sessionId });
        } catch (e) {
          log.warn('session/cancel failed', { message: (e as Error).message });
        }
      },

      async close() {
        if (closed) return;
        closed = true;
        turnInFlight = false;
        dismissAllPending('session_closed', 'deny');
        await client.close({ reason: 'CursorAgentSession.close()' });
        isolated.dispose();
        eventQueue.end();
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

      async setModel(newModel: string) {
        if (closed) throw new Error('Cursor session is closed');
        const productId = toCursorProductModelId(newModel);
        if (productId === mutableModel) {
          // 同模型仍刷新一次 config，确保 effort/fast 元数据跟上。
          const options = await setConfigOption('model', toCursorAcpModelId(productId));
          await applyConfigEnrichment(productId, options);
          return;
        }
        log.debug('setModel', { from: mutableModel, to: productId });
        const options = await setConfigOption('model', toCursorAcpModelId(productId));
        mutableModel = productId;
        await applyConfigEnrichment(productId, options);
      },

      async setEffort(newEffort: Effort) {
        if (closed) throw new Error('Cursor session is closed');
        if (!latestConfigOptions.some((o) => o.id === 'effort')) {
          // 当前模型无 effort 选项：先刷新 model config 再试一次。
          const refreshed = await setConfigOption('model', toCursorAcpModelId(mutableModel));
          await applyConfigEnrichment(mutableModel, refreshed);
        }
        if (!latestConfigOptions.some((o) => o.id === 'effort')) {
          throw new NotSupportedError('effort', {
            supported: false,
            reason: 'sdk-missing',
            message: `Cursor model ${mutableModel} does not expose effort`,
          });
        }
        log.debug('setEffort', { from: mutableEffort, to: newEffort });
        const options = await setConfigOption('effort', newEffort);
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
    };

    return handle;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
