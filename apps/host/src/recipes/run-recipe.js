import path from 'node:path';
import { extractDocumentText } from '../workspace/document-extractor.js';
import { assertTrustedPath } from '../security/path-policy.js';
import { buildRecipeOperations, getRecipe } from './registry.js';
import { createRunId, writeRunRecord } from '../runtime/run-store.js';
import { summariseRunForIndex } from '../runtime/runs-index.js';

/**
 * @typedef {import('./recipe-helpers.js').SourceLike} RecipeSource
 * @typedef {import('../workspace/file-operations.js').FileOperationInput} FileOperationInput
 * @typedef {Error & { statusCode?: number, payload?: Record<string, unknown> }} RecipeError
 * @typedef {{ publish(runId: string, event: Record<string, unknown>): Record<string, unknown> }} RunEventsLike
 * @typedef {{ upsert(summary: unknown, context?: Record<string, unknown>): unknown }} RunsIndexLike
 * @typedef {{ recipeId: string, trustedRoot: string, prompt?: unknown, files?: unknown[], maxSize?: unknown, context?: Record<string, unknown>, runStoreRoot: string, runEvents?: RunEventsLike | null, runsIndex?: RunsIndexLike | null }} RunRecipeOptions
 * @typedef {{ ok: boolean, runId: string, runPath: string, recipe: NonNullable<ReturnType<typeof getRecipe>>, sources: RecipeSource[], operations: FileOperationInput[], events: Record<string, unknown>[] }} RunRecipeResult
 */

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

/** @param {RecipeSource[]} sources @returns {number} */
function bytesOf(sources) {
  return sources.reduce((sum, s) => sum + (Number(s.size) || 0), 0);
}

/** @param {RunRecipeOptions} options @returns {RunRecipeResult} */
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
}) {
  const recipe = getRecipe(recipeId);
  if (!recipe) {
    const err = /** @type {RecipeError} */ (new Error('Recipe not found'));
    err.statusCode = 404;
    throw err;
  }
  if (!runStoreRoot) {
    throw new Error('runRecipe: runStoreRoot required');
  }
  const safeRoot = assertTrustedPath(path.resolve(trustedRoot), path.resolve(trustedRoot));
  const startedAt = new Date();
  const runId = createRunId();
  /** @type {Record<string, unknown>[]} */
  const events = [];

  /** @param {string} type @param {Record<string, unknown>} [payload] @returns {Record<string, unknown>} */
  const emit = (type, payload = {}) => {
    let enriched;
    if (runEvents) {
      enriched = runEvents.publish(runId, { type, ...payload });
    } else {
      enriched = { seq: events.length + 1, ts: new Date().toISOString(), type, ...payload };
    }
    events.push(enriched);
    return enriched;
  };

  emit('user_message', { text: String(prompt || '').slice(0, 2000) });
  emit('assistant_start', { status: 'planning', recipeId, recipeName: recipe.name });

  const requestedFiles = Array.isArray(files) ? files.slice(0, 12) : [];
  /** @type {RecipeSource[]} */
  const sources = [];
  for (const item of requestedFiles) {
    const fileRecord = /** @type {{ fullPath?: unknown, path?: unknown }} */ (
      item && typeof item === 'object' ? item : {}
    );
    const filePath = typeof item === 'string'
      ? item
      : typeof fileRecord.fullPath === 'string'
        ? fileRecord.fullPath
        : typeof fileRecord.path === 'string'
          ? fileRecord.path
          : '';
    if (!filePath) {
      continue;
    }
    try {
      sources.push(extractDocumentText(filePath, { trustedRoot: safeRoot, maxSize }));
    } catch (err) {
      const error = /** @type {Error} */ (err);
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

  /** @type {FileOperationInput[]} */
  let operations;
  try {
    operations = buildRecipeOperations({ recipeId, trustedRoot: safeRoot, prompt, sources });
  } catch (err) {
    const error = /** @type {RecipeError} */ (err);
    emit('assistant_end', { status: 'failed', error: error.message });
    const finishedAt = new Date();
    const failRecord = {
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
    const runPath = writeRunRecord(runStoreRoot, failRecord);
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

  const sourceSummaries = sources.map((source) => ({
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

  const record = {
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
