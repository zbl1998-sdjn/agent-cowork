// 运行档案清道夫(host · L2 运行时 · runtime)
// ---------------------------------------------------------------------------
// 职责:host 启动时把上一进程遗留的 status=running 运行档案标为 interrupted——
//       新进程里不可能有存活的旧 run,这些档案只会让任务中心永久显示假"进行中"。
//       只动 running;awaiting_approval(配方待审批)等合法持久状态不受影响。
//       清理是诊断路径,任何失败都不阻断启动。
// 依赖:L1 storage 的 run-store/runs-index(经兼容出口)。导出:markInterruptedRuns。
import { readRunRecord, writeRunRecord } from './run-store.js';
import { summariseRunForIndex } from './runs-index.js';

export const INTERRUPTED_RUN_ERROR = '宿主重启时该运行被中断;如有检查点可从任务原对话续跑。';

type JanitorRunsIndex = {
  list?(options: Record<string, unknown>): unknown[] | Promise<unknown[]>;
  upsert(summary: unknown, context?: Record<string, unknown>): unknown;
};

export type MarkInterruptedOptions = {
  runStoreRoot: string;
  runsIndex: JanitorRunsIndex;
  now?: Date;
};

/** 把索引里所有 status=running 的档案改写为 interrupted(含错误说明与结束时间),并同步索引。 */
export async function markInterruptedRuns({ runStoreRoot, runsIndex, now = new Date() }: MarkInterruptedOptions): Promise<string[]> {
  const marked: string[] = [];
  if (typeof runsIndex.list !== 'function') return marked;
  let stale: unknown[];
  try {
    stale = await runsIndex.list({ status: 'running', limit: 500 });
  } catch {
    return marked;
  }
  for (const entry of Array.isArray(stale) ? stale : []) {
    const id = entry && typeof entry === 'object' ? String((entry as { id?: unknown }).id || '') : '';
    if (!id) continue;
    try {
      const record = readRunRecord(runStoreRoot, id) as Record<string, unknown> | null;
      if (!record || record.status !== 'running') continue;
      const startedAt = Date.parse(String(record.startedAt || ''));
      const patched: Record<string, unknown> = {
        ...record,
        status: 'interrupted',
        error: INTERRUPTED_RUN_ERROR,
        finishedAt: now.toISOString(),
        ...(Number.isFinite(startedAt) ? { durationMs: Math.max(0, now.getTime() - startedAt) } : {}),
      };
      const runPath = writeRunRecord(runStoreRoot, patched as unknown as Parameters<typeof writeRunRecord>[1]);
      const context = record.context && typeof record.context === 'object' ? record.context as Record<string, unknown> : {};
      runsIndex.upsert(summariseRunForIndex({ ...patched, runPath }, context), context);
      marked.push(id);
    } catch {
      // 单条失败继续处理其余档案。
    }
  }
  return marked;
}
