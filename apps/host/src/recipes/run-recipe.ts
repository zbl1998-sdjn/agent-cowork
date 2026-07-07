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
import { buildAiRecipeOperations, hasAiRecipeBuilder } from './model-recipe.js';
import { createRunId, writeRunRecord } from '../runtime/run-store.js';
import { summariseRunForIndex } from '../runtime/runs-index.js';
import type { FileOperationInput } from '../workspace/file-operations.js';
import type { RunRecord } from '../runtime/run-store.js';
import type { RecipeError, RecipeSource, RunRecipeOptions, RunRecipeResult } from './run-recipe-types.js';

// runRecipe 是配方执行的唯一入口:HTTP 手动运行与调度器复用同一路径,确保产物、run 记录和事件时间线一致。
// 副作用集中在写 run 记录、可选更新 runsIndex、可选发布 runEvents;返回执行摘要与可审批操作。

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
export async function runRecipe({
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
  modelConfig = null,
}: RunRecipeOptions): Promise<RunRecipeResult> {
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
    // 来源熔断(grounded 原则):转换型配方在 0 个可用来源时拒绝产出空壳交付物,
    // 与 MASE「检索不到就明说」同一哲学——没有原料不开工,失败也走统一 run 记录。
    if (recipe.requiresSources) {
      const usableSources = sources.filter((source) => !source.error && (source.content || '').trim().length > 0);
      if (usableSources.length === 0) {
        const guardError: RecipeError = new Error(
          `配方「${recipe.name}」需要来源材料:请先用「引用文件」选择要处理的文件再运行(本次引用 ${sources.length} 个,可用 0 个)。`,
        );
        guardError.statusCode = 422;
        throw guardError;
      }
    }
    // AI 路径优先(有模型且该 recipe 支持):模型结构化提取 → 提取到就用,否则回退模板。
    let aiOps: FileOperationInput[] | null = null;
    if (modelConfig && hasAiRecipeBuilder(recipe.id)) {
      emit('progress', { icon: 'loader', text: `AI 正在从来源提取 ${recipe.name}…` });
      aiOps = await buildAiRecipeOperations({ trustedRoot: safeRoot, recipe, sources, prompt: String(prompt || ''), modelConfig: modelConfig as Record<string, unknown> });
      if (aiOps) emit('progress', { icon: 'check', text: `AI 提取完成，生成 ${aiOps.length} 个产物` });
    }
    operations = aiOps || buildRecipeOperations({ recipeId, trustedRoot: safeRoot, prompt, sources, recipe });
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
        // 索引失败不能反过来打断已经失败记录的落盘。
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
      // 索引失败不影响配方主结果;run 记录已经是事实来源。
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
