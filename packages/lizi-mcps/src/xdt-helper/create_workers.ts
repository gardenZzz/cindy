/**
 * xdt-helper/create_workers.ts —— 确定性批量创建 Orca workers。
 *
 * 批次先用首项探测 host 返回的名额快照，再按剩余名额切分可创建前缀与超限后缀；
 * 可创建前缀受并发上限约束，结果仍按请求顺序汇总逐项终态。
 */

import { BRAND_NAME } from '@cindy/maker-shared/branding';
import { z } from 'zod';

import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import { okPayload, errorPayload } from './_payload.js';
import {
  createWorkerSpecSchema,
  toWorkerLimitPayload,
  type CreateWorkerDeps,
  type CreateWorkerSpec,
  type WorkerLimitSnapshot,
} from './create_worker.js';

const workersSchema = z
  .array(createWorkerSpecSchema)
  .min(2)
  .max(32)
  .superRefine((workers, ctx) => {
    const labels = new Set<string>();
    workers.forEach((worker, index) => {
      const canonical = worker.label.toLowerCase();
      if (labels.has(canonical)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, 'label'],
          message: `duplicate label in batch: ${worker.label}`,
        });
      }
      labels.add(canonical);
    });
  });

const DESCRIPTION = [
  '在当前 workflow 内批量创建 2-32 个 Orca worker session。',
  '用户一次要求创建多个 Worker 时必须使用本工具，不要并行或连续多次调用 create_worker。',
  '本工具先根据名额快照切分可创建前缀与超限后缀，在可创建前缀内有界并发并按请求顺序返回真实逐项终态；超限后缀标记 skipped，不调用 host。',
  '结果包含 request_count / attempted_count / success_count / failure_count / skipped_count / not_created_count、hard limit 快照、确定生成的 user_report，以及每个 label 对应的 worker/session 或失败原因。success/failure/skipped 是互斥分区。',
  '工具返回后必须向用户逐字转告 user_report 并补充逐项结果；达到 hard limit 时同时转告 suggestions 中的调整设置、复用 Worker 或分批执行方案。',
  'create_workers 建的是持久、UI 可见的 Orca workers，不是一次性 subagent。',
].join('\n');

interface CreatedWorkerResult {
  label: string;
  role: string;
  agent: CreateWorkerSpec['agent'];
  status: 'created';
  worker_id: string;
  worker_session_id: string;
  dispatched?: boolean;
  dispatch_outcome?: unknown;
  queued_message_id?: string;
  warning?: 'WORKER_LIMIT_SOFT_EXCEEDED';
}

interface FailedWorkerResult {
  label: string;
  role: string;
  agent: CreateWorkerSpec['agent'];
  status: 'failed' | 'skipped';
  error_code: string;
  hint: string;
}

type BatchWorkerResult = CreatedWorkerResult | FailedWorkerResult;
type BatchStopReason = 'WORKER_LIMIT_HARD_EXCEEDED' | 'HOST_NOT_READY';

// 并发度上限取 4——#35 实测每个并发 cursor-agent 峰值约 320MB，4 并发共约 1.3GB、
// 每会话仅劣化 15% 并拿到 3.3× 墙钟改善；8 并发内存翻倍到 2.5GB 而吞吐只再涨 1.8×，
// 性价比不划算。workers 上限是 32，不设限最坏情况 10GB+。
const MAX_CONCURRENT_WORKER_CREATIONS = 4;

function baseResult(worker: CreateWorkerSpec) {
  return {
    label: worker.label,
    role: worker.role,
    agent: worker.agent,
  };
}

function hardLimitSuggestions(): string[] {
  return [
    '在协同设置中提高 Worker hard limit 后，只重试未创建项。',
    '复用已有 Worker，通过 send_to_worker 继续派发任务。',
    '归档不再需要的 Worker 释放名额，或把剩余任务分批执行。',
  ];
}

function hostNotReadySuggestions(): string[] {
  return [`等待 ${BRAND_NAME} 主进程协同服务就绪后，只重试未创建项。`];
}

function buildUserReport(params: {
  requestCount: number;
  successCount: number;
  failureCount: number;
  skippedCount: number;
  stopReason: BatchStopReason | undefined;
  limit: WorkerLimitSnapshot | undefined;
}): string {
  const notCreatedCount = params.failureCount + params.skippedCount;
  const base = `本批请求创建 ${params.requestCount} 个 Worker，实际创建成功 ${params.successCount} 个，创建失败 ${params.failureCount} 个，未尝试 ${params.skippedCount} 个，共 ${notCreatedCount} 个未创建`;
  if (params.stopReason === 'WORKER_LIMIT_HARD_EXCEEDED' && params.limit) {
    return `${base}；当前 hard limit 为 ${params.limit.workerHardLimit}，已占用 ${params.limit.occupiedSlots} 个槽位。可在协同设置中提高 hard limit、复用已有 Worker，或归档不再需要的 Worker 后分批执行剩余任务。`;
  }
  if (params.stopReason === 'HOST_NOT_READY') {
    return `${base}；${BRAND_NAME} 主进程协同服务尚未就绪，请等待服务就绪后只重试未创建项。`;
  }
  return `${base}。请按逐项结果核对每个 Worker 的真实终态。`;
}

function workerCreateParams(leadSessionId: string, worker: CreateWorkerSpec) {
  return {
    leadSessionId,
    role: worker.role,
    agent: worker.agent,
    model: worker.model,
    effort: worker.effort,
    fast: worker.fast,
    label: worker.label,
    initialTask: worker.initial_task,
  };
}

function failureFromThrownError(worker: CreateWorkerSpec, error: unknown): FailedWorkerResult {
  const errorCode = error && typeof error === 'object' && 'code' in error
    && typeof error.code === 'string'
    ? error.code
    : 'INTERNAL';
  return {
    ...baseResult(worker),
    status: 'failed',
    error_code: errorCode,
    hint: error instanceof Error ? error.message : String(error),
  };
}

function resultFromCreateWorker(
  worker: CreateWorkerSpec,
  result: Awaited<ReturnType<CreateWorkerDeps['createWorker']>>,
): BatchWorkerResult {
  if (!result.ok) {
    return {
      ...baseResult(worker),
      status: 'failed',
      error_code: result.errorCode,
      hint: result.message,
    };
  }
  return {
    ...baseResult(worker),
    status: 'created',
    worker_id: result.workerId,
    worker_session_id: result.workerSessionId,
    ...(result.dispatched !== undefined ? { dispatched: result.dispatched } : {}),
    ...(result.dispatchOutcome ? { dispatch_outcome: result.dispatchOutcome } : {}),
    ...(result.queuedMessageId ? { queued_message_id: result.queuedMessageId } : {}),
    ...(result.softLimitExceeded ? { warning: 'WORKER_LIMIT_SOFT_EXCEEDED' as const } : {}),
  };
}

function moreRecentLimit(
  current: WorkerLimitSnapshot | undefined,
  candidate: WorkerLimitSnapshot | undefined,
): WorkerLimitSnapshot | undefined {
  if (!candidate) return current;
  if (!current || candidate.occupiedSlots >= current.occupiedSlots) return candidate;
  return current;
}

export function registerCreateWorkersTool(
  registry: XdtHelperToolRegistry,
  deps: CreateWorkerDeps,
): void {
  registry.register({
    name: 'create_workers',
    category: 'control',
    description: DESCRIPTION,
    inputShape: {
      workers: workersSchema.describe('按期望创建顺序排列的 Worker 定义；label 在本批内忽略大小写唯一'),
    },
    handler: async ({ workers }) => {
      const ctx = deps.getSessionContext?.() ?? deps;
      if (!ctx.sessionId) {
        return errorPayload('LEAD_NOT_SUPPORTED', '当前 session 类型不支持作为 Lead。');
      }
      if (ctx.vendorOptions?.orcaRole === 'worker') {
        return errorPayload(
          'WORKER_CANNOT_NEST',
          'create_workers 是 Orca Lead 批量创建 worker session 的入口，不是 subagent 入口；Worker session 不能嵌套创建 Orca Worker。',
        );
      }

      const results: BatchWorkerResult[] = [];
      let attemptedCount = 0;
      let successCount = 0;
      let skippedCount = 0;
      let limit: WorkerLimitSnapshot | undefined;
      let stopReason: BatchStopReason | undefined;
      const indexedResults: Array<BatchWorkerResult | undefined> = Array.from({
        length: workers.length,
      });
      let hostNotReadyIndex: number | undefined;
      let hardLimitIndex: number | undefined;
      let nextIndex = 1;

      const stopIndex = () => Math.min(
        hostNotReadyIndex ?? Number.POSITIVE_INFINITY,
        hardLimitIndex ?? Number.POSITIVE_INFINITY,
      );

      const invoke = async (index: number): Promise<void> => {
        const worker = workers[index]!;
        attemptedCount += 1;
        try {
          const result = await deps.createWorker(workerCreateParams(ctx.sessionId!, worker));
          limit = moreRecentLimit(limit, result.limit);
          indexedResults[index] = resultFromCreateWorker(worker, result);
          if (!result.ok && result.errorCode === 'HOST_NOT_READY') {
            hostNotReadyIndex = Math.min(hostNotReadyIndex ?? index, index);
          } else if (!result.ok && result.errorCode === 'WORKER_LIMIT_HARD_EXCEEDED') {
            hardLimitIndex = Math.min(hardLimitIndex ?? index, index);
          }
        } catch (error) {
          const failed = failureFromThrownError(worker, error);
          indexedResults[index] = failed;
          if (failed.error_code === 'HOST_NOT_READY') {
            hostNotReadyIndex = Math.min(hostNotReadyIndex ?? index, index);
          } else if (failed.error_code === 'WORKER_LIMIT_HARD_EXCEEDED') {
            hardLimitIndex = Math.min(hardLimitIndex ?? index, index);
          }
        }
      };

      // 当前 host 没有独立的只读名额查询 seam，因此首项既是兼容性探测，也是实际创建；
      // 一旦拿到 limit，后续调用才按剩余槽位切前缀，保证超限后缀不会触碰 host。
      await invoke(0);
      if (indexedResults[0]?.status === 'failed' && hostNotReadyIndex === 0) {
        stopReason = 'HOST_NOT_READY';
      } else if (hardLimitIndex === 0) {
        stopReason = 'WORKER_LIMIT_HARD_EXCEEDED';
      }

      let eligibleEnd = workers.length;
      if (stopReason === undefined && limit) {
        const remainingSlots = Number.isFinite(limit.remainingSlots)
          ? Math.max(0, Math.floor(limit.remainingSlots))
          : workers.length;
        eligibleEnd = Math.min(workers.length, 1 + remainingSlots);
        if (eligibleEnd < workers.length) {
          hardLimitIndex = eligibleEnd - 1;
        }
      }

      // 没有 limit 的旧 host 继续走有界并发；host 一旦返回硬限或未就绪，调度器停止
      // 发起尚未入飞的后续调用，已入飞的调用仍结算真实终态。
      const runNext = async (): Promise<void> => {
        while (nextIndex < eligibleEnd) {
          const index = nextIndex;
          nextIndex += 1;
          if (index > stopIndex()) return;
          await invoke(index);
        }
      };
      if (stopReason === undefined && nextIndex < eligibleEnd) {
        const workerCount = Math.min(
          MAX_CONCURRENT_WORKER_CREATIONS,
          eligibleEnd - nextIndex,
        );
        await Promise.all(Array.from({ length: workerCount }, () => runNext()));
      }

      if (hostNotReadyIndex !== undefined) {
        stopReason = 'HOST_NOT_READY';
      } else if (hardLimitIndex !== undefined) {
        stopReason = 'WORKER_LIMIT_HARD_EXCEEDED';
      }

      const skipReason = stopReason;
      const firstStopIndex = stopReason === 'HOST_NOT_READY'
        ? hostNotReadyIndex
        : hardLimitIndex;
      for (let index = 0; index < workers.length; index += 1) {
        if (indexedResults[index]) continue;
        const worker = workers[index]!;
        const shouldSkip = firstStopIndex !== undefined
          ? index > firstStopIndex
          : index >= eligibleEnd;
        if (!shouldSkip || !skipReason) {
          // 理论上只有首项 host 异常且 promise 没有写入结果才会到这里；保守保留
          // 可观察终态，避免批次汇总出现空洞。
          indexedResults[index] = failureFromThrownError(
            worker,
            new Error('worker creation did not settle'),
          );
          continue;
        }
        skippedCount += 1;
        indexedResults[index] = {
          ...baseResult(worker),
          status: 'skipped',
          error_code: skipReason,
          hint: skipReason === 'WORKER_LIMIT_HARD_EXCEEDED'
            ? '同批已达到 Worker hard limit，未再调用 host 创建。'
            : `${BRAND_NAME} 主进程协同服务尚未就绪，未再调用 host 创建。`,
        };
      }

      results.push(...indexedResults as BatchWorkerResult[]);
      successCount = results.filter((result) => result.status === 'created').length;
      const failureCount = results.filter((result) => result.status === 'failed').length;
      skippedCount = results.filter((result) => result.status === 'skipped').length;
      const notCreatedCount = failureCount + skippedCount;
      const userReport = buildUserReport({
        requestCount: workers.length,
        successCount,
        failureCount,
        skippedCount,
        stopReason,
        limit,
      });
      const payload = {
        request_count: workers.length,
        attempted_count: attemptedCount,
        success_count: successCount,
        failure_count: failureCount,
        skipped_count: skippedCount,
        not_created_count: notCreatedCount,
        stopped_early: stopReason !== undefined,
        ...(stopReason ? { stop_reason: stopReason } : {}),
        ...(limit ? { limit: toWorkerLimitPayload(limit) } : {}),
        user_report: userReport,
        results,
        suggestions: stopReason === 'WORKER_LIMIT_HARD_EXCEEDED'
          ? hardLimitSuggestions()
          : stopReason === 'HOST_NOT_READY'
            ? hostNotReadySuggestions()
            : [],
      };
      if (stopReason === 'HOST_NOT_READY') {
        return errorPayload(
          'HOST_NOT_READY',
          `${BRAND_NAME} 主进程协同服务尚未就绪。`,
          payload,
        );
      }
      return okPayload(payload);
    },
  });
}
