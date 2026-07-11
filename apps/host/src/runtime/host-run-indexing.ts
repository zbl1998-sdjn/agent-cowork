// Host 运行索引写入(host · L2 运行时 · runtime)
// ---------------------------------------------------------------------------
// 职责:把完整运行记录归一化为索引摘要；索引同步失败不得中断请求主路径。
import { summariseRunForIndex } from './runs-index.js';
import type { RunsIndexLike } from '../recipes/run-recipe-types.js';

export function indexHostRun(
  runsIndex: RunsIndexLike,
  record: Record<string, unknown>,
  contextOverride?: Record<string, unknown>,
): void {
  try {
    const rawContext = record.context;
    const context = contextOverride
      || (rawContext && typeof rawContext === 'object' ? rawContext as Record<string, unknown> : {});
    runsIndex.upsert(summariseRunForIndex({ ...record, runPath: record.runPath }, context), context);
  } catch {
    // 索引失败不应打断请求主路径。
  }
}
