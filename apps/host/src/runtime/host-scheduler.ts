// 主机调度器装配(host · L2 运行时 · runtime)
// ---------------------------------------------------------------------------
// 职责:从 host-state 中分离计划任务调度器的创建逻辑,保持主状态装配文件聚焦在依赖汇总。
// 依赖:同层 scheduler + storage/cached-pg-schedule-store + L1 recipes。
import path from 'node:path';
import { runRecipe } from '../recipes/run-recipe.js';
import { createCachedPostgresScheduleStore } from '../storage/cached-pg-schedule-store.js';
import { Scheduler, createScheduleStore } from './scheduler.js';

type HostSchedulerConfig = Record<string, any>;
type HostSchedulerState = Record<string, any> & {
  activeScheduler?: Scheduler | null;
  runStoreRoot: string;
};
type ScheduleRecordLike = {
  id: string;
  tenantId?: string;
  userId?: string;
  traceId?: string | null;
  payload?: unknown;
};

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
    const payload = record.payload && typeof record.payload === 'object'
      ? record.payload as Record<string, any>
      : {};
    if (!payload.recipeId) return { runId: null, note: `scheduler-noop:${record.id}` };
    const result = runRecipe({
      recipeId: payload.recipeId,
      trustedRoot: state.safeTrustedRoot(payload.trustedRoot || trustedRootDefault),
      prompt: payload.prompt || '',
      files: payload.files || [],
      maxSize: payload.maxSize,
      context: { tenantId: record.tenantId, userId: record.userId, traceId: record.traceId || '' },
      runStoreRoot: state.runStoreRoot,
      runEvents: state.runEvents,
      runsIndex: state.runsIndex,
    });
    return { runId: result.runId, operations: result.operations.length };
  };
  const executor = config.scheduleExecutor || defaultScheduleExecutor;
  state.activeScheduler = new Scheduler({
    storeDir: scheduleStoreDir,
    store: config.scheduleStore || (state.usePostgresState
      ? createCachedPostgresScheduleStore({ connectionString: state.databaseUrl })
      : createScheduleStore({
        backend: state.storeBackend,
        storeDir: scheduleStoreDir,
        dbPath: state.sqliteDbPath,
      })),
    executor,
    tickIntervalMs: config.schedulerTickMs || 30_000,
  });
  if (config.startScheduler !== false) state.activeScheduler.start();
}
