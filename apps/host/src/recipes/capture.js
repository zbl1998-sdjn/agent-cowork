import fs from 'node:fs';
import path from 'node:path';
import { redactText, redactValue } from '../security/redaction.js';

const MAX_TEXT = 4000;
const RUN_ID_RE = /^[a-z0-9_-]+$/i;

function clipText(value, max = MAX_TEXT) {
  const text = redactText(value == null ? '' : String(value));
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function cleanValue(value) {
  return redactValue(value);
}

async function readRecordFromIndex(runId, runsIndex) {
  if (!runsIndex || typeof runsIndex.get !== 'function') {
    return null;
  }
  const indexed = await runsIndex.get(runId);
  if (!indexed || !indexed.runPath || !fs.existsSync(indexed.runPath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(indexed.runPath, 'utf8'));
}

function readRecordFromStoreRoot(runId, runStoreRoot) {
  if (!runStoreRoot) return null;
  if (!RUN_ID_RE.test(runId || '')) throw new Error('Invalid run id');
  const runPath = path.join(runStoreRoot, `${runId}.json`);
  if (!fs.existsSync(runPath)) return null;
  return JSON.parse(fs.readFileSync(runPath, 'utf8'));
}

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

function eventSteps(record) {
  const events = Array.isArray(record.events) ? record.events : [];
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

function resultSteps(record) {
  const rawSteps = Array.isArray(record.result?.steps) ? record.result.steps : [];
  return rawSteps.map((step, index) => ({
    index,
    tool: clipText(step.tool, 120),
    status: step.status || (step.ok === false ? 'failed' : 'succeeded'),
    summary: cleanValue(step.summary || {}),
  }));
}

function recipeOperationSteps(record) {
  const events = Array.isArray(record.events) ? record.events : [];
  const preview = events.find((event) => event && event.type === 'preview' && Array.isArray(event.operations));
  if (!preview) {
    return [];
  }
  return preview.operations.map((operation, index) => ({
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

function extractArtifacts(record) {
  const artifacts = [];
  const seen = new Set();
  const add = (artifact) => {
    const path = clipText(artifact.path || artifact.fullPath || '', 500);
    if (!path || seen.has(path)) {
      return;
    }
    seen.add(path);
    artifacts.push({
      path,
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

function titleFromRecord(record, runId) {
  if (record.recipeId) {
    return `Captured ${record.recipeId}`;
  }
  if (record.command) {
    return `Captured ${record.command}`;
  }
  return `Captured run ${runId}`;
}

export async function captureRun({ runId, runStoreRoot = null, runsIndex = null, recordReader = null } = {}) {
  if (!runId || typeof runId !== 'string') {
    const err = new Error('captureRun: runId is required');
    err.statusCode = 400;
    throw err;
  }
  const record = await loadRunRecord({ runId, runStoreRoot, runsIndex, recordReader });
  if (!record) {
    const err = new Error('Run record not found');
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
