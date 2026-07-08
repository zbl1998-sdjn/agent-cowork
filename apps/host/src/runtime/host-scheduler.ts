// 主机调度器装配(host · L2 运行时 · runtime)
// ---------------------------------------------------------------------------
// 职责:从 host-state 中分离计划任务调度器的创建逻辑,保持主状态装配文件聚焦在依赖汇总。
// 依赖:同层 scheduler + storage/cached-pg-schedule-store + L1 recipes。
import path from 'node:path';
import { runRecipe } from '../recipes/run-recipe.js';
import { createCachedPostgresScheduleStore } from '../storage/cached-pg-schedule-store.js';
import { omitUndefined } from '../util/object.js';
import { Scheduler, createScheduleStore } from './scheduler.js';
import type { RunEventsLike, RunsIndexLike } from '../recipes/run-recipe-types.js';
import type { ScheduleStore, SchedulerExecutor } from './scheduler.js';
import type { StoreBackend } from './store-backend-config.js';

type HostSchedulerConfig = Record<string, unknown> & {
  scheduler?: Scheduler | null;
  enableScheduler?: boolean;
  scheduleStoreDir?: string;
  scheduleExecutor?: SchedulerExecutor;
  scheduleStore?: ScheduleStore | null;
  schedulerTickMs?: number;
  startScheduler?: boolean;
};
type HostSchedulerState = Record<string, unknown> & {
  activeScheduler?: Scheduler | null;
  databaseUrl?: string | null;
  runEvents?: unknown;
  runsIndex?: unknown;
  runStoreRoot: string;
  safeTrustedRoot(requestedRoot?: unknown): string;
  sqliteDbPath?: string;
  storeBackend?: StoreBackend;
  usePostgresState?: boolean;
  // 定时任务复用与手动运行相同的 AI recipe 路径:有模型配置就走 AI 提取(过出站策略检查),
  // 否则回退模板。此前定时任务从不传 modelConfig,导致自动化的 recipe 永远是机械模板输出——
  // 用户设了「每周一自动生成周报」享受不到 AI 提取(功能完整性缺口,非安全问题)。
  kimiApiConfig?: { configured?: boolean } & Record<string, unknown>;
};
type ScheduleRecordLike = {
  id: string;
  tenantId?: string;
  userId?: string;
  traceId?: string | null;
  payload?: unknown;
};
type RecipeSchedulePayload = {
  recipeId?: unknown;
  trustedRoot?: unknown;
  prompt?: unknown;
  files?: unknown;
  maxSize?: unknown;
};

function schedulePayload(value: unknown): RecipeSchedulePayload {
  return value && typeof value === 'object' ? value as RecipeSchedulePayload : {};
}

export function configureHostScheduler({
  config,
  state,
  trustedRootDefault,
}: {
  config: HostSchedulerConfig;
  state: HostSchedulerState;
  trustedRootDefault: string;
}): void {
  state.activeScheduler = config.scheduler || null;
  if (state.activeScheduler || config.enableScheduler === false) {
    return;
  }

  const scheduleStoreDir = path.resolve(
    config.scheduleStoreDir || path.join(trustedRootDefault, '.AgentCowork', 'schedules'),
  );
  const defaultScheduleExecutor = async (record: ScheduleRecordLike) => {
    const payload = schedulePayload(record.payload);
    if (!payload.recipeId) {
      // 不静默 no-op:prompt-only 定时任务没有可执行动作,抛清晰错误,由 Scheduler 记为
      // failed(而非假"completed"),用户才能在历史里看到它并没真正执行。
      throw new Error(`定时任务 ${record.id} 未绑定可执行动作(缺 recipeId),无法自动执行;请改为绑定一个配方/动作再设定。`);
    }
    const result = await runRecipe(omitUndefined({
      recipeId: String(payload.recipeId),
      trustedRoot: state.safeTrustedRoot(payload.trustedRoot || trustedRootDefault),
      prompt: payload.prompt || '',
      files: Array.isArray(payload.files) ? payload.files : [],
      maxSize: payload.maxSize,
      context: { tenantId: record.tenantId, userId: record.userId, traceId: record.traceId || '' },
      runStoreRoot: state.runStoreRoot,
      runEvents: state.runEvents as RunEventsLike | null | undefined,
      runsIndex: state.runsIndex as RunsIndexLike | null | undefined,
      modelConfig: state.kimiApiConfig?.configured ? state.kimiApiConfig : null,
    }));
    return { runId: result.runId, operations: result.operations.length };
  };
  const executor = config.scheduleExecutor || defaultScheduleExecutor;
  state.activeScheduler = new Scheduler({
    storeDir: scheduleStoreDir,
    store: config.scheduleStore || (
      state.usePostgresState
      ? createCachedPostgresScheduleStore(omitUndefined({ connectionString: state.databaseUrl })) as unknown as ScheduleStore
      : createScheduleStore(omitUndefined({
        backend: state.storeBackend,
        storeDir: scheduleStoreDir,
        dbPath: state.sqliteDbPath,
      }))
    ),
    executor,
    tickIntervalMs: config.schedulerTickMs || 30_000,
  });
  if (config.startScheduler !== false) state.activeScheduler.start();
}
