// 运行捕获(host · L1 领域层 · recipes)
// ---------------------------------------------------------------------------
// 职责:读取一条 run 记录,提炼其步骤/产物/提示词并「脱敏」,组装成可保存的自定义配方草稿。
//       是「把这次跑的流程存成配方」的取数侧;所有文本经 redaction 抹密。
// 依赖:L0 security/redaction。导出:captureRun。
import fs from 'node:fs';
import path from 'node:path';
import { redactText, redactValue } from '../security/redaction.js';
import type {
  ArtifactLike,
  CapturedArtifact,
  CapturedStep,
  CaptureRunOptions,
  CaptureRunResult,
  RunRecord,
  RunsIndexLike,
} from './capture-types.js';

const MAX_TEXT = 4000;
const RUN_ID_RE = /^[a-z0-9_-]+$/i;

function clipText(value: unknown, max = MAX_TEXT): string {
  const text = redactText(value == null ? '' : String(value)) ?? '';
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function cleanValue(value: unknown): unknown {
  return redactValue(value);
}

async function readRecordFromIndex(runId: string, runsIndex: RunsIndexLike | null | undefined): Promise<RunRecord | null> {
  if (!runsIndex || typeof runsIndex.get !== 'function') {
    return null;
  }
  const indexed = await runsIndex.get(runId);
  const runPath = typeof indexed?.runPath === 'string' ? indexed.runPath : '';
  if (!runPath || !fs.existsSync(runPath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(runPath, 'utf8')) as RunRecord;
}

function readRecordFromStoreRoot(runId: string, runStoreRoot: string | null | undefined): RunRecord | null {
  if (!runStoreRoot) {
    return null;
  }
  if (!RUN_ID_RE.test(runId || '')) {
    throw new Error('Invalid run id');
  }
  const runPath = path.join(runStoreRoot, `${runId}.json`);
  if (!fs.existsSync(runPath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(runPath, 'utf8')) as RunRecord;
}

async function loadRunRecord({ runId, runStoreRoot, runsIndex, recordReader }: Required<Pick<CaptureRunOptions, 'runId'>> & Omit<CaptureRunOptions, 'runId'>): Promise<RunRecord | null> {
  let record: RunRecord | null = null;
  if (typeof recordReader === 'function') {
    record = await recordReader(runId as string);
  }
  if (runStoreRoot) {
    record ||= readRecordFromStoreRoot(runId as string, runStoreRoot);
  }
  return record || (await readRecordFromIndex(runId as string, runsIndex));
}

function eventSteps(record: RunRecord): CapturedStep[] {
  const events = Array.isArray(record.events) ? record.events : [];
  const steps: CapturedStep[] = [];
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

function resultSteps(record: RunRecord): CapturedStep[] {
  const rawSteps = Array.isArray(record.result?.steps) ? record.result.steps : [];
  return rawSteps.map((step, index) => ({
    index,
    tool: clipText(step.tool, 120),
    status: step.status || (step.ok === false ? 'failed' : 'succeeded'),
    summary: cleanValue(step.summary || {}),
  }));
}

function recipeOperationSteps(record: RunRecord): CapturedStep[] {
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

function extractSteps(record: RunRecord): CapturedStep[] {
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

function extractArtifacts(record: RunRecord): CapturedArtifact[] {
  const artifacts: CapturedArtifact[] = [];
  const seen = new Set<string>();
  const add = (artifact: ArtifactLike): void => {
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

function titleFromRecord(record: RunRecord, runId: string): string {
  if (record.recipeId) {
    return `Captured ${record.recipeId}`;
  }
  if (record.command) {
    return `Captured ${record.command}`;
  }
  return `Captured run ${runId}`;
}

/** 捕获一次运行为配方草稿:定位并读取 run 记录,提炼步骤/产物/提示词并脱敏,返回可保存的草稿。 */
export async function captureRun({ runId, runStoreRoot = null, runsIndex = null, recordReader = null }: CaptureRunOptions = {}): Promise<CaptureRunResult> {
  if (!runId || typeof runId !== 'string') {
    const err: Error & { statusCode?: number } = new Error('captureRun: runId is required');
    err.statusCode = 400;
    throw err;
  }
  const record = await loadRunRecord({ runId, runStoreRoot, runsIndex, recordReader });
  if (!record) {
    const err: Error & { statusCode?: number } = new Error('Run record not found');
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
