import fs from 'node:fs';
import path from 'node:path';
import { redactText, redactValue } from '../security/redaction.js';

// @ts-check

const MAX_TEXT = 4000;
const RUN_ID_RE = /^[a-z0-9_-]+$/i;

/**
 * @typedef {{ type?: unknown, path?: unknown, fullPath?: unknown, kind?: unknown, source?: unknown, encoding?: unknown, contentBase64?: unknown }} ArtifactLike
 * @typedef {{ index: number, tool: string, status?: unknown, args?: unknown, result?: unknown, summary?: unknown }} CapturedStep
 * @typedef {{ type?: unknown, name?: unknown, tool?: unknown, args?: unknown, status?: unknown, result?: ArtifactLike, path?: unknown, operations?: ArtifactLike[], items?: ArtifactLike[] }} RunEvent
 * @typedef {{ tool?: unknown, status?: unknown, ok?: unknown, summary?: unknown }} ResultStep
 * @typedef {{ prompt?: unknown, summary?: unknown }} RunInput
 * @typedef {{ text?: unknown, steps?: ResultStep[] }} RunResult
 * @typedef {{ message?: unknown }} RunError
 * @typedef {{ recipeId?: unknown, command?: unknown, events?: RunEvent[], result?: RunResult, input?: RunInput, error?: RunError, type?: unknown, status?: unknown, mode?: unknown, provider?: unknown, startedAt?: unknown, finishedAt?: unknown }} RunRecord
 * @typedef {{ runPath?: unknown }} RunIndexEntry
 * @typedef {{ get(runId: string): RunIndexEntry | null | Promise<RunIndexEntry | null> }} RunsIndexLike
 * @typedef {(runId: string) => RunRecord | null | Promise<RunRecord | null>} RecordReader
 */

/** @param {unknown} value @param {number} [max] @returns {string} */
function clipText(value, max = MAX_TEXT) {
  const redacted = redactText(value == null ? '' : String(value));
  const text = typeof redacted === 'string' ? redacted : '';
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

/** @param {unknown} value @returns {unknown} */
function cleanValue(value) {
  return redactValue(value);
}

/** @param {string} runId @param {RunsIndexLike | null | undefined} runsIndex @returns {Promise<RunRecord | null>} */
async function readRecordFromIndex(runId, runsIndex) {
  if (!runsIndex || typeof runsIndex.get !== 'function') {
    return null;
  }
  const indexed = await runsIndex.get(runId);
  const runPath = typeof indexed?.runPath === 'string' ? indexed.runPath : '';
  if (!runPath || !fs.existsSync(runPath)) {
    return null;
  }
  return /** @type {RunRecord} */ (JSON.parse(fs.readFileSync(runPath, 'utf8')));
}

/** @param {string} runId @param {string | null} runStoreRoot @returns {RunRecord | null} */
function readRecordFromStoreRoot(runId, runStoreRoot) {
  if (!runStoreRoot) return null;
  if (!RUN_ID_RE.test(runId || '')) throw new Error('Invalid run id');
  const runPath = path.join(runStoreRoot, `${runId}.json`);
  if (!fs.existsSync(runPath)) return null;
  return /** @type {RunRecord} */ (JSON.parse(fs.readFileSync(runPath, 'utf8')));
}

/** @param {{ runId: string, runStoreRoot?: string | null, runsIndex?: RunsIndexLike | null, recordReader?: RecordReader | null }} options */
async function loadRunRecord({ runId, runStoreRoot, runsIndex, recordReader }) {
  let record = null;
  if (typeof recordReader === 'function') {
    record = await recordReader(runId);
  }
  if (runStoreRoot) {
    record ||= readRecordFromStoreRoot(runId, runStoreRoot);
  }
  return record || await readRecordFromIndex(runId, runsIndex);
}

/** @param {RunRecord} record @returns {CapturedStep[]} */
function eventSteps(record) {
  const events = Array.isArray(record.events) ? record.events : [];
  /** @type {CapturedStep[]} */
  const steps = [];
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    if (!event || event.type !== 'tool_call') {
      continue;
    }
    const resultEvent = events.slice(i + 1).find((candidate) => (
      candidate
      && candidate.type === 'tool_result'
      && (candidate.name === event.name || candidate.tool === event.name)
    ));
    steps.push({
      index: steps.length,
      tool: clipText(event.name, 120),
      args: cleanValue(event.args || {}),
      status: resultEvent?.status || undefined,
      result: resultEvent?.result ? cleanValue(resultEvent.result) : undefined,
    });
  }
  return steps;
}

/** @param {RunRecord} record @returns {CapturedStep[]} */
function resultSteps(record) {
  const rawSteps = Array.isArray(record.result?.steps) ? record.result.steps : [];
  return rawSteps.map((step, index) => ({
    index,
    tool: clipText(step.tool, 120),
    status: step.status || (step.ok === false ? 'failed' : 'succeeded'),
    summary: cleanValue(step.summary || {}),
  }));
}

/** @param {RunRecord} record @returns {CapturedStep[]} */
function recipeOperationSteps(record) {
  const events = Array.isArray(record.events) ? record.events : [];
  const preview = events.find((event) => event && event.type === 'preview' && Array.isArray(event.operations));
  if (!preview) {
    return [];
  }
  const operations = Array.isArray(preview.operations) ? preview.operations : [];
  return operations.map((operation, index) => ({
    index,
    tool: 'recipe.operation',
    status: 'previewed',
    args: {
      type: clipText(operation.type, 80),
      path: clipText(operation.path, 500),
      encoding: operation.encoding || (operation.contentBase64 ? 'base64' : undefined),
    },
  }));
}

/** @param {RunRecord} record @returns {CapturedStep[]} */
function extractSteps(record) {
  const fromEvents = eventSteps(record);
  if (fromEvents.length) {
    return fromEvents;
  }
  const fromRecipe = recipeOperationSteps(record);
  if (fromRecipe.length) {
    return fromRecipe;
  }
  return resultSteps(record);
}

/** @param {RunRecord} record */
function extractArtifacts(record) {
  /** @type {ArtifactLike[]} */
  const artifacts = [];
  const seen = new Set();
  /** @param {ArtifactLike} artifact */
  const add = (artifact) => {
    const artifactPath = clipText(artifact.path || artifact.fullPath || '', 500);
    if (!artifactPath || seen.has(artifactPath)) {
      return;
    }
    seen.add(artifactPath);
    artifacts.push({
      path: artifactPath,
      kind: clipText(artifact.kind || artifact.type || 'file', 80),
      source: artifact.source,
    });
  };

  for (const event of Array.isArray(record.events) ? record.events : []) {
    if (event?.type === 'file_written' && event.path) {
      add({ path: event.path, kind: 'file', source: 'file_written' });
    }
    if (event?.type === 'preview' && Array.isArray(event.operations)) {
      for (const operation of event.operations) {
        if (operation?.path) {
          add({ path: operation.path, kind: operation.type || 'operation', source: 'preview' });
        }
      }
    }
    if (event?.type === 'sources' && Array.isArray(event.items)) {
      for (const item of event.items) {
        if (item?.path) {
          add({ path: item.path, kind: item.kind || 'source', source: 'source' });
        }
      }
    }
    if (event?.type === 'tool_result' && event.result?.path) {
      add({ path: event.result.path, kind: 'file', source: 'tool_result' });
    }
  }

  return artifacts;
}

/** @param {RunRecord} record @param {string} runId @returns {string} */
function titleFromRecord(record, runId) {
  if (record.recipeId) {
    return `Captured ${record.recipeId}`;
  }
  if (record.command) {
    return `Captured ${record.command}`;
  }
  return `Captured run ${runId}`;
}

/** @param {{ runId?: unknown, runStoreRoot?: string | null, runsIndex?: RunsIndexLike | null, recordReader?: RecordReader | null }} [options] */
export async function captureRun({ runId, runStoreRoot = null, runsIndex = null, recordReader = null } = {}) {
  if (!runId || typeof runId !== 'string') {
    const err = /** @type {Error & { statusCode?: number }} */ (new Error('captureRun: runId is required'));
    err.statusCode = 400;
    throw err;
  }
  const record = await loadRunRecord({ runId, runStoreRoot, runsIndex, recordReader });
  if (!record) {
    const err = /** @type {Error & { statusCode?: number }} */ (new Error('Run record not found'));
    err.statusCode = 404;
    throw err;
  }

  const prompt = clipText(record.input?.prompt || record.input?.summary || '');
  const steps = extractSteps(record);
  const artifacts = extractArtifacts(record);
  return {
    ok: true,
    recipe: {
      schemaVersion: 1,
      draft: true,
      sourceRunId: runId,
      name: titleFromRecord(record, runId),
      description: clipText(record.result?.text || record.error?.message || record.type || ''),
      prompt,
      steps,
      artifacts,
      source: {
        type: clipText(record.type, 120),
        status: clipText(record.status, 80),
        mode: clipText(record.mode, 80),
        provider: clipText(record.provider, 120),
        recipeId: record.recipeId ? clipText(record.recipeId, 120) : null,
        startedAt: record.startedAt || null,
        finishedAt: record.finishedAt || null,
      },
      redacted: true,
    },
  };
}
