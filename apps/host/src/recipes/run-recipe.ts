// 配方执行(host · L1 领域层 · recipes)
// ---------------------------------------------------------------------------
// 职责:执行配方的「唯一事实来源」——HTTP 路由(POST /api/recipes/:id/run)与调度器都走它,
//       使「计划任务」产出与「手动运行」一致的可审批产物 + run 记录 + 事件时间线。
//       读取来源材料 → 构建可审批操作 → 发出事件/落 run 记录;失败也落失败 run 记录。
// 依赖:L0 path-policy + workspace/document-extractor + 同层 registry;按既有架构豁免向
//       runtime/run-store、runs-index 记账。导出:runRecipe。
import path from 'node:path';
import { extractDocumentText } from '../workspace/document-extractor.js';
import { assertTrustedPath } from '../security/path-policy.js';
import { omitUndefined } from '../util/object.js';
import { buildRecipeOperations, getRecipe } from './registry.js';
import { createRunId, writeRunRecord } from '../runtime/run-store.js';
import { summariseRunForIndex } from '../runtime/runs-index.js';
import type { FileOperationInput } from '../workspace/file-operations.js';
import type { RunRecord } from '../runtime/run-store.js';
import type { RecipeError, RecipeSource, RunRecipeOptions, RunRecipeResult } from './run-recipe-types.js';

// Single source of truth for executing a recipe. Used by both the HTTP route
// (POST /api/recipes/:id/run) and the scheduler executor, so a scheduled run
// produces the same approvable artifacts + run record + event timeline as a
// manual run.
//
// Side effects:
//   - writes a run record (with embedded events[]) via writeRunRecord
//   - upserts into runsIndex (if provided)
//   - publishes a timeline of events to runEvents (if provided)
//
// Returns { ok, runId, runPath, recipe, sources, operations, events }.

function bytesOf(sources: RecipeSource[]): number {
  return sources.reduce((sum, source) => sum + (Number(source.size) || 0), 0);
}

function recipeError(error: unknown): RecipeError {
  return error instanceof Error ? error : new Error(String(error));
}

function filePathFromRequest(item: unknown): string {
  const fileRecord = item && typeof item === 'object' ? item as { fullPath?: unknown; path?: unknown } : {};
  return typeof item === 'string'
    ? item
    : typeof fileRecord.fullPath === 'string'
      ? fileRecord.fullPath
      : typeof fileRecord.path === 'string'
        ? fileRecord.path
        : '';
}

function emitFailedRun({
  error,
  runId,
  recipeId,
  safeRoot,
  startedAt,
  context,
  prompt,
  events,
  runStoreRoot,
}: {
  error: RecipeError;
  runId: string;
  recipeId: string;
  safeRoot: string;
  startedAt: Date;
  context: Record<string, unknown>;
  prompt: unknown;
  events: Record<string, unknown>[];
  runStoreRoot: string;
}): { failRecord: RunRecord; runPath: string } {
  const finishedAt = new Date();
  const failRecord: RunRecord = {
    id: runId,
    type: 'recipe-run',
    provider: 'agent-cowork-host',
    command: recipeId,
    recipeId,
    mode: 'cowork',
    trustedRoot: safeRoot,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    status: 'failed',
    context,
    input: { prompt: String(prompt || '') },
    error: { message: error.message },
    events,
  };
  return { failRecord, runPath: writeRunRecord(runStoreRoot, failRecord) };
}

/** 执行一个配方:读来源→构建可审批操作→发事件并写 run 记录,返回 { ok, runId, recipe, sources, operations, events }。 */
export function runRecipe({
  recipeId,
  trustedRoot,
  prompt = '',
  files = [],
  maxSize,
  context = {},
  runStoreRoot,
  runEvents = null,
  runsIndex = null,
  recipe: providedRecipe = null,
}: RunRecipeOptions): RunRecipeResult {
  const recipe = providedRecipe || getRecipe(recipeId);
  if (!recipe) {
    const err: RecipeError = new Error('Recipe not found');
    err.statusCode = 404;
    throw err;
  }
  if (!runStoreRoot) {
    throw new Error('runRecipe: runStoreRoot required');
  }
  const safeRoot = assertTrustedPath(path.resolve(trustedRoot), path.resolve(trustedRoot));
  const startedAt = new Date();
  const runId = createRunId();
  const events: Record<string, unknown>[] = [];

  const emit = (type: string, payload: Record<string, unknown> = {}): Record<string, unknown> => {
    const enriched = runEvents
      ? runEvents.publish(runId, { type, ...payload })
      : { seq: events.length + 1, ts: new Date().toISOString(), type, ...payload };
    events.push(enriched);
    return enriched;
  };

  emit('user_message', { text: String(prompt || '').slice(0, 2000) });
  emit('assistant_start', { status: 'planning', recipeId, recipeName: recipe.name });

  const requestedFiles = Array.isArray(files) ? files.slice(0, 12) : [];
  const sources: RecipeSource[] = [];
  for (const item of requestedFiles) {
    const filePath = filePathFromRequest(item);
    if (!filePath) {
      continue;
    }
    try {
      sources.push(extractDocumentText(filePath, { trustedRoot: safeRoot, maxSize }));
    } catch (err) {
      const error = recipeError(err);
      const safePath = assertTrustedPath(filePath, safeRoot);
      sources.push({
        path: safePath,
        relativePath: path.relative(safeRoot, safePath).replace(/\\/g, '/'),
        error: error.message,
      });
    }
  }
  emit('progress', {
    icon: 'check',
    text: `已读取 ${sources.length} 个来源 (${bytesOf(sources)} 字节)`,
  });

  let operations: FileOperationInput[];
  try {
    operations = buildRecipeOperations({ recipeId, trustedRoot: safeRoot, prompt, sources, recipe });
  } catch (err) {
    const error = recipeError(err);
    emit('assistant_end', { status: 'failed', error: error.message });
    const { failRecord, runPath } = emitFailedRun({
      error,
      runId,
      recipeId,
      safeRoot,
      startedAt,
      context,
      prompt,
      events,
      runStoreRoot,
    });
    if (runsIndex) {
      try {
        runsIndex.upsert(summariseRunForIndex({ ...failRecord, runPath }, context), context);
      } catch {
        // index failures never break the run
      }
    }
    error.payload = { runId, runPath };
    throw error;
  }

  emit('progress', { icon: 'loader', text: `正在生成 ${recipe.name} 的可审批操作…` });
  emit('preview', { operations, count: operations.length });
  emit('awaiting_approval', { count: operations.length });

  const sourceSummaries: RecipeSource[] = sources.map((source) => omitUndefined({
    path: source.path,
    relativePath: source.relativePath,
    kind: source.kind,
    size: source.size,
    sha256: source.sha256,
    excerpt: source.content ? source.content.slice(0, 500) : '',
    error: source.error,
  }));
  emit('sources', { items: sourceSummaries });

  const finishedAt = new Date();
  const durationMs = finishedAt.getTime() - startedAt.getTime();
  emit('assistant_end', { status: 'succeeded', durationMs });

  const record: RunRecord = {
    id: runId,
    type: 'recipe-run',
    provider: 'agent-cowork-host',
    command: recipeId,
    recipeId,
    mode: 'cowork',
    trustedRoot: safeRoot,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs,
    status: 'succeeded',
    context,
    input: {
      prompt: String(prompt || ''),
      summary: sources
        .map((source) => `${source.relativePath}: ${(source.content || source.error || '').slice(0, 160)}`)
        .join('\n'),
    },
    result: {
      ok: true,
      text: `${recipe.name} 已生成 ${operations.length} 个可审批操作。`,
    },
    events,
  };
  const runPath = writeRunRecord(runStoreRoot, record);

  if (runsIndex) {
    try {
      runsIndex.upsert(summariseRunForIndex({ ...record, runPath }, context), context);
    } catch {
      // index failures never break the run
    }
  }

  return {
    ok: true,
    runId,
    runPath,
    recipe,
    sources: sourceSummaries,
    operations,
    events,
  };
}
