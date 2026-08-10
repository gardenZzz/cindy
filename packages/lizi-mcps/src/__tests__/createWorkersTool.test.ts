/** create_workers 批量编排回归：真实汇总、hard-limit 短路与连续失败。 */

import { describe, expect, it, vi } from 'vitest';

import { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { XdtHelperToolResult } from '../lizi_xdtHelperToolRegistry.js';
import { registerCreateWorkersTool } from '../xdt-helper/create_workers.js';
import type {
  CreateWorkerControlResult,
  CreateWorkerDeps,
  CreateWorkerSpec,
} from '../xdt-helper/create_worker.js';

function parse(result: XdtHelperToolResult) {
  const [block] = result.content;
  if (block?.type !== 'text') throw new Error('Expected first MCP content block to be text');
  return JSON.parse(block.text);
}

function worker(index: number): CreateWorkerSpec {
  return {
    role: 'developer',
    agent: 'codex',
    label: `worker_${index}`,
    initial_task: `task ${index}`,
  };
}

function setup(
  createWorker: CreateWorkerDeps['createWorker'],
  getWorkerLimitSnapshot?: CreateWorkerDeps['getWorkerLimitSnapshot'],
) {
  const registry = new XdtHelperToolRegistry();
  registerCreateWorkersTool(registry, {
    sessionId: 'lead-1',
    createWorker,
    ...(getWorkerLimitSnapshot ? { getWorkerLimitSnapshot } : {}),
  });
  return registry;
}

function created(index: number, hardLimit: number) {
  return {
    ok: true as const,
    workerId: `worker-id-${index}`,
    workerSessionId: `worker-session-${index}`,
    limit: {
      workerHardLimit: hardLimit,
      occupiedSlots: index,
      remainingSlots: hardLimit - index,
    },
  };
}

function hardLimitFailure(hardLimit: number) {
  return {
    ok: false as const,
    errorCode: 'WORKER_LIMIT_HARD_EXCEEDED' as const,
    message: `hard limit ${hardLimit} reached`,
    limit: {
      workerHardLimit: hardLimit,
      occupiedSlots: hardLimit,
      remainingSlots: 0,
    },
  };
}

function hostNotReadyFailure() {
  return {
    ok: false as const,
    errorCode: 'HOST_NOT_READY' as const,
    message: 'host booting',
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('create_workers tool', () => {
  it('routes multi-worker requests to one deterministic batch tool', () => {
    const createWorker = vi.fn<CreateWorkerDeps['createWorker']>();
    const registry = setup(createWorker);

    expect(registry.get('create_workers')?.description).toContain(
      '用户一次要求创建多个 Worker 时必须使用本工具，不要并行或连续多次调用 create_worker。',
    );
  });

  it('rejects duplicate labels before creating any worker', async () => {
    const createWorker = vi.fn<CreateWorkerDeps['createWorker']>();
    const registry = setup(createWorker);

    const result = await registry.call('create_workers', {
      workers: [worker(1), { ...worker(2), label: 'WORKER_1' }],
    });

    expect(result.isError).toBe(true);
    expect(parse(result)).toMatchObject({ ok: false, errorCode: 'INVALID_ARGS' });
    expect(createWorker).not.toHaveBeenCalled();
  });

  it('rejects unknown fields inside worker specs instead of silently dropping them', async () => {
    const createWorker = vi.fn<CreateWorkerDeps['createWorker']>();
    const registry = setup(createWorker);

    const result = await registry.call('create_workers', {
      workers: [
        { ...worker(1), initialTask: 'camelCase should fail' },
        worker(2),
      ],
    });

    expect(result.isError).toBe(true);
    expect(parse(result)).toMatchObject({ ok: false, errorCode: 'INVALID_ARGS' });
    expect(createWorker).not.toHaveBeenCalled();
  });

  it('does not call host for the hard-limit suffix and summarizes all nine requests', async () => {
    let call = 0;
    const createWorker = vi.fn<CreateWorkerDeps['createWorker']>(async () => {
      call += 1;
      return call <= 3 ? created(call, 3) : hardLimitFailure(3);
    });
    const registry = setup(createWorker);

    const result = parse(await registry.call('create_workers', {
      workers: Array.from({ length: 9 }, (_, index) => worker(index + 1)),
    }));

    expect(result).toMatchObject({
      ok: true,
      request_count: 9,
      attempted_count: 3,
      success_count: 3,
      failure_count: 0,
      skipped_count: 6,
      not_created_count: 6,
      stopped_early: true,
      stop_reason: 'WORKER_LIMIT_HARD_EXCEEDED',
      limit: { hard_limit: 3, occupied_slots: 3, remaining_slots: 0 },
      user_report: '本批请求创建 9 个 Worker，实际创建成功 3 个，创建失败 0 个，未尝试 6 个，共 6 个未创建；当前 hard limit 为 3，已占用 3 个槽位。可在协同设置中提高 hard limit、复用已有 Worker，或归档不再需要的 Worker 后分批执行剩余任务。',
    });
    expect(createWorker).toHaveBeenCalledTimes(3);
    expect(result.success_count + result.failure_count + result.skipped_count).toBe(result.request_count);
    expect(result.results.map((entry: { status: string }) => entry.status)).toEqual([
      'created', 'created', 'created', 'skipped', 'skipped', 'skipped', 'skipped', 'skipped', 'skipped',
    ]);
    expect(result.suggestions).toHaveLength(3);
  });

  it('reports the default hard=8 boundary for the ninth request', async () => {
    let call = 0;
    const createWorker = vi.fn<CreateWorkerDeps['createWorker']>(async () => {
      call += 1;
      return call <= 8 ? created(call, 8) : hardLimitFailure(8);
    });
    const registry = setup(createWorker);

    const result = parse(await registry.call('create_workers', {
      workers: Array.from({ length: 9 }, (_, index) => worker(index + 1)),
    }));

    expect(result).toMatchObject({
      request_count: 9,
      attempted_count: 8,
      success_count: 8,
      failure_count: 0,
      skipped_count: 1,
      not_created_count: 1,
      limit: { hard_limit: 8, occupied_slots: 8, remaining_slots: 0 },
    });
  });

  it('uses a read-only snapshot before entering the pool so the first worker is concurrent', async () => {
    const gate = deferred<void>();
    const getWorkerLimitSnapshot = vi.fn<NonNullable<CreateWorkerDeps['getWorkerLimitSnapshot']>>(async () => ({
      workerHardLimit: 8,
      occupiedSlots: 0,
      remainingSlots: 8,
    }));
    let inFlight = 0;
    let maxInFlight = 0;
    const createWorker = vi.fn<CreateWorkerDeps['createWorker']>(async ({ label }) => {
      const index = Number(label.split('_')[1]);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await gate.promise;
      inFlight -= 1;
      return created(index, 8);
    });
    const registry = setup(createWorker, getWorkerLimitSnapshot);
    const request = registry.call('create_workers', {
      workers: Array.from({ length: 5 }, (_, index) => worker(index + 1)),
    });

    await vi.waitFor(() => expect(createWorker).toHaveBeenCalledTimes(4));
    expect(getWorkerLimitSnapshot).toHaveBeenCalledTimes(1);
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(4);
    gate.resolve();

    const result = parse(await request);
    expect(result).toMatchObject({
      attempted_count: 5,
      success_count: 5,
      failure_count: 0,
      skipped_count: 0,
    });
  });

  it('skips the suffix from a read-only snapshot without calling host for it', async () => {
    const getWorkerLimitSnapshot = vi.fn<NonNullable<CreateWorkerDeps['getWorkerLimitSnapshot']>>(async () => ({
      workerHardLimit: 5,
      occupiedSlots: 2,
      remainingSlots: 3,
    }));
    const createWorker = vi.fn<CreateWorkerDeps['createWorker']>(async ({ label }) => {
      const index = Number(label.split('_')[1]);
      return {
        ...created(index, 5),
        limit: {
          workerHardLimit: 5,
          occupiedSlots: index + 2,
          remainingSlots: 3 - index,
        },
      };
    });
    const registry = setup(createWorker, getWorkerLimitSnapshot);

    const result = parse(await registry.call('create_workers', {
      workers: Array.from({ length: 5 }, (_, index) => worker(index + 1)),
    }));

    expect(getWorkerLimitSnapshot).toHaveBeenCalledTimes(1);
    expect(createWorker).toHaveBeenCalledTimes(3);
    expect(createWorker.mock.calls.map(([params]) => params.label)).toEqual([
      'worker_1', 'worker_2', 'worker_3',
    ]);
    expect(result).toMatchObject({
      request_count: 5,
      attempted_count: 3,
      success_count: 3,
      failure_count: 0,
      skipped_count: 2,
      not_created_count: 2,
      stopped_early: true,
      stop_reason: 'WORKER_LIMIT_HARD_EXCEEDED',
      limit: { hard_limit: 5, occupied_slots: 5, remaining_slots: 0 },
    });
    expect(result.results.map((entry: { status: string }) => entry.status)).toEqual([
      'created', 'created', 'created', 'skipped', 'skipped',
    ]);
    expect(result.results.slice(3).every((entry: { error_code: string }) => (
      entry.error_code === 'WORKER_LIMIT_HARD_EXCEEDED'
    ))).toBe(true);
  });

  // 回退路径靠首项带回的 limit 切分，首项普通失败就拿不到快照；只读快照必须与
  // 任何一次创建的成败无关，否则超限后缀又会被放进并发池。
  it('keeps the snapshot suffix skipped even when the first worker fails for an unrelated reason', async () => {
    const getWorkerLimitSnapshot = vi.fn<NonNullable<CreateWorkerDeps['getWorkerLimitSnapshot']>>(async () => ({
      workerHardLimit: 5,
      occupiedSlots: 2,
      remainingSlots: 3,
    }));
    const createWorker = vi.fn<CreateWorkerDeps['createWorker']>(async ({ label }) => {
      if (label === 'worker_1') {
        return {
          ok: false as const,
          errorCode: 'DUPLICATE_LABEL' as const,
          message: 'label already used',
        } satisfies CreateWorkerControlResult;
      }
      return created(Number(label.split('_')[1]), 5);
    });
    const registry = setup(createWorker, getWorkerLimitSnapshot);

    const result = parse(await registry.call('create_workers', {
      workers: Array.from({ length: 5 }, (_, index) => worker(index + 1)),
    }));

    expect(createWorker).toHaveBeenCalledTimes(3);
    expect(createWorker.mock.calls.map(([params]) => params.label)).toEqual([
      'worker_1', 'worker_2', 'worker_3',
    ]);
    expect(result).toMatchObject({
      request_count: 5,
      attempted_count: 3,
      success_count: 2,
      failure_count: 1,
      skipped_count: 2,
      not_created_count: 3,
      stopped_early: true,
      stop_reason: 'WORKER_LIMIT_HARD_EXCEEDED',
    });
    expect(result.results.map((entry: { status: string }) => entry.status)).toEqual([
      'failed', 'created', 'created', 'skipped', 'skipped',
    ]);
    expect(result.results[0]).toMatchObject({ error_code: 'DUPLICATE_LABEL' });
  });

  it('falls back to the首项探测 path when the read-only snapshot fails', async () => {
    const workers = Array.from({ length: 5 }, (_, index) => worker(index + 1));
    const createWithoutSnapshot = vi.fn<CreateWorkerDeps['createWorker']>(async ({ label }) => (
      created(Number(label.split('_')[1]), 8)
    ));
    const withoutSnapshot = parse(await setup(createWithoutSnapshot).call('create_workers', { workers }));

    const getWorkerLimitSnapshot = vi.fn<NonNullable<CreateWorkerDeps['getWorkerLimitSnapshot']>>(async () => {
      throw new Error('snapshot unavailable');
    });
    const createWithFailedSnapshot = vi.fn<CreateWorkerDeps['createWorker']>(async ({ label }) => (
      created(Number(label.split('_')[1]), 8)
    ));
    const withFailedSnapshot = parse(await setup(
      createWithFailedSnapshot,
      getWorkerLimitSnapshot,
    ).call('create_workers', { workers }));

    expect(getWorkerLimitSnapshot).toHaveBeenCalledTimes(1);
    expect(withFailedSnapshot).toEqual(withoutSnapshot);
    expect(createWithFailedSnapshot).toHaveBeenCalledTimes(5);
  });

  it('keeps real per-item outcomes when a non-limit failure occurs between successes', async () => {
    const outcomes = [
      created(1, 8),
      { ok: false as const, errorCode: 'DUPLICATE_LABEL' as const, message: 'duplicate label' },
      created(2, 8),
    ];
    const createWorker = vi.fn<CreateWorkerDeps['createWorker']>(async () => outcomes.shift()!);
    const registry = setup(createWorker);

    const result = parse(await registry.call('create_workers', {
      workers: [worker(1), worker(2), worker(3)],
    }));

    expect(result).toMatchObject({
      attempted_count: 3,
      success_count: 2,
      failure_count: 1,
      skipped_count: 0,
      not_created_count: 1,
      stopped_early: false,
      user_report: '本批请求创建 3 个 Worker，实际创建成功 2 个，创建失败 1 个，未尝试 0 个，共 1 个未创建。请按逐项结果核对每个 Worker 的真实终态。',
    });
    expect(result.results).toEqual([
      expect.objectContaining({ label: 'worker_1', status: 'created', worker_id: 'worker-id-1' }),
      expect.objectContaining({ label: 'worker_2', status: 'failed', error_code: 'DUPLICATE_LABEL' }),
      expect.objectContaining({ label: 'worker_3', status: 'created', worker_id: 'worker-id-2' }),
    ]);
  });

  it('reports consecutive non-limit failures without inventing created workers', async () => {
    const outcomes = [
      { ok: false as const, errorCode: 'INVALID_PARAMS' as const, message: 'bad model' },
      { ok: false as const, errorCode: 'NO_PROVIDER_FOR_AGENT' as const, message: 'provider missing' },
      { ok: false as const, errorCode: 'INTERNAL' as const, message: 'bootstrap failed' },
    ];
    const createWorker = vi.fn<CreateWorkerDeps['createWorker']>(async () => outcomes.shift()!);
    const registry = setup(createWorker);

    const result = parse(await registry.call('create_workers', {
      workers: [worker(1), worker(2), worker(3)],
    }));

    expect(result).toMatchObject({
      attempted_count: 3,
      success_count: 0,
      failure_count: 3,
      skipped_count: 0,
      not_created_count: 3,
      stopped_early: false,
    });
    expect(result.results.every((entry: { status: string }) => entry.status === 'failed')).toBe(true);
    expect(result.results.some((entry: { worker_id?: string }) => entry.worker_id)).toBe(false);
  });

  it('starts multiple eligible creations before any deferred creation resolves', async () => {
    const gate = deferred<void>();
    let inFlight = 0;
    let maxInFlight = 0;
    const createWorker = vi.fn<CreateWorkerDeps['createWorker']>(async ({ label }) => {
      const index = Number(label.split('_')[1]);
      if (index === 1) return created(index, 8);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await gate.promise;
      inFlight -= 1;
      return created(index, 8);
    });
    const registry = setup(createWorker);
    const request = registry.call('create_workers', {
      workers: Array.from({ length: 5 }, (_, index) => worker(index + 1)),
    });

    await vi.waitFor(() => expect(createWorker).toHaveBeenCalledTimes(5));
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(4);
    gate.resolve();

    const result = parse(await request);
    expect(result).toMatchObject({
      attempted_count: 5,
      success_count: 5,
      failure_count: 0,
      skipped_count: 0,
    });
  });

  it('never has more than four worker creations in flight', async () => {
    const gate = deferred<void>();
    let inFlight = 0;
    let maxInFlight = 0;
    const createWorker = vi.fn<CreateWorkerDeps['createWorker']>(async ({ label }) => {
      const index = Number(label.split('_')[1]);
      if (index === 1) return created(index, 32);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await gate.promise;
      inFlight -= 1;
      return created(index, 32);
    });
    const registry = setup(createWorker);
    const request = registry.call('create_workers', {
      workers: Array.from({ length: 10 }, (_, index) => worker(index + 1)),
    });

    await vi.waitFor(() => expect(createWorker).toHaveBeenCalledTimes(5));
    expect(maxInFlight).toBe(4);
    gate.resolve();

    const result = parse(await request);
    expect(result).toMatchObject({
      request_count: 10,
      attempted_count: 10,
      success_count: 10,
      failure_count: 0,
      skipped_count: 0,
    });
    expect(maxInFlight).toBeLessThanOrEqual(4);
  });

  it('keeps later successful in-flight workers and skips unstarted workers after HOST_NOT_READY', async () => {
    const gate = deferred<void>();
    const createWorker = vi.fn<CreateWorkerDeps['createWorker']>(async ({ label }) => {
      const index = Number(label.split('_')[1]);
      if (index === 1) return created(index, 8);
      if (index === 2) return hostNotReadyFailure();
      await gate.promise;
      return created(index, 8);
    });
    const registry = setup(createWorker);
    const request = registry.call('create_workers', {
      workers: Array.from({ length: 8 }, (_, index) => worker(index + 1)),
    });

    await vi.waitFor(() => expect(createWorker).toHaveBeenCalledTimes(5));
    gate.resolve();

    const response = await request;
    const result = parse(response);
    expect(response.isError).toBe(true);
    expect(result).toMatchObject({
      ok: false,
      errorCode: 'HOST_NOT_READY',
      data: {
        request_count: 8,
        attempted_count: 5,
        success_count: 4,
        failure_count: 1,
        skipped_count: 3,
        not_created_count: 4,
        stopped_early: true,
        stop_reason: 'HOST_NOT_READY',
      },
    });
    expect(createWorker.mock.calls.map(([params]) => params.label)).toEqual([
      'worker_1', 'worker_2', 'worker_3', 'worker_4', 'worker_5',
    ]);
    expect(result.data.results.map((entry: { status: string }) => entry.status)).toEqual([
      'created', 'failed', 'created', 'created', 'created', 'skipped', 'skipped', 'skipped',
    ]);
  });

  it('preserves request order and isolates a thrown creation from other outcomes', async () => {
    const pending = new Map<number, ReturnType<typeof deferred<CreateWorkerControlResult>>>();
    const createWorker = vi.fn<CreateWorkerDeps['createWorker']>(async ({ label }) => {
      const index = Number(label.split('_')[1]);
      if (index === 1) return created(index, 8);
      const wait = deferred<CreateWorkerControlResult>();
      pending.set(index, wait);
      return wait.promise;
    });
    const registry = setup(createWorker);
    const request = registry.call('create_workers', {
      workers: Array.from({ length: 4 }, (_, index) => worker(index + 1)),
    });

    await vi.waitFor(() => expect(createWorker).toHaveBeenCalledTimes(4));
    pending.get(4)!.resolve(created(4, 8));
    pending.get(3)!.resolve({
      ok: false,
      errorCode: 'DUPLICATE_LABEL',
      message: 'duplicate label',
    });
    pending.get(2)!.reject(new Error('bootstrap failed'));

    const result = parse(await request);
    expect(result).toMatchObject({
      request_count: 4,
      attempted_count: 4,
      success_count: 2,
      failure_count: 2,
      skipped_count: 0,
      not_created_count: 2,
      stopped_early: false,
    });
    expect(result.results.map((entry: { label: string }) => entry.label)).toEqual([
      'worker_1', 'worker_2', 'worker_3', 'worker_4',
    ]);
    expect(result.results.every((entry: { status: string }) => (
      entry.status === 'created' || entry.status === 'failed' || entry.status === 'skipped'
    ))).toBe(true);
    expect(result.results.filter((entry: { status: string }) => entry.status === 'created')).toHaveLength(2);
    expect(result.results.filter((entry: { status: string }) => entry.status === 'failed')).toHaveLength(2);
    expect(result.results.filter((entry: { status: string }) => entry.status === 'skipped')).toHaveLength(0);
    expect(result.results[1]).toMatchObject({
      label: 'worker_2',
      status: 'failed',
      error_code: 'INTERNAL',
      hint: 'bootstrap failed',
    });
  });

  it('stops immediately and returns an explicit tool error when the host is not ready', async () => {
    const createWorker = vi.fn<CreateWorkerDeps['createWorker']>(async () => hostNotReadyFailure());
    const registry = setup(createWorker);

    const response = await registry.call('create_workers', {
      workers: [worker(1), worker(2), worker(3)],
    });
    const result = parse(response);

    expect(response.isError).toBe(true);
    expect(result).toMatchObject({
      ok: false,
      errorCode: 'HOST_NOT_READY',
      data: {
        request_count: 3,
        attempted_count: 1,
        success_count: 0,
        failure_count: 1,
        skipped_count: 2,
        not_created_count: 3,
        stopped_early: true,
        stop_reason: 'HOST_NOT_READY',
        hint: expect.stringContaining('主进程协同服务尚未就绪'),
      },
    });
    expect(result.data.results.map((entry: { status: string }) => entry.status)).toEqual([
      'failed', 'skipped', 'skipped',
    ]);
    expect(createWorker).toHaveBeenCalledTimes(1);
  });
});
