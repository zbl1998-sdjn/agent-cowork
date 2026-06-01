import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runRecipe } from '../src/recipes/run-recipe.js';
import { captureRun } from '../src/recipes/capture.js';
import { RunEventBus } from '../src/runtime/run-events.js';
import { RunsIndex } from '../src/runtime/runs-index.js';
import { writeRunRecord } from '../src/runtime/run-store.js';
import { listRecipes } from '../src/recipes/registry.js';
import { readZipEntries } from '../src/workspace/zip-utils.js';
import type { FileOperationInput } from '../src/workspace/file-operations.js';

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-recipe-'));
}

function firstRecipeId(): string {
  const recipe = listRecipes()[0];
  assert.ok(recipe, 'expected at least one recipe fixture');
  return recipe.id;
}

function eventAt(events: readonly Record<string, unknown>[], index: number): Record<string, unknown> {
  const event = events[index];
  assert.ok(event, `expected event at index ${index}`);
  return event;
}

function firstItem<T>(items: readonly T[], label: string): T {
  const item = items[0];
  assert.ok(item, `expected ${label}`);
  return item;
}

function operationPath(operation: FileOperationInput): string {
  assert.ok(operation.path, 'operation should include a path');
  return operation.path;
}

function operationWithExt(operations: readonly FileOperationInput[], ext: string): FileOperationInput {
  const operation = operations.find((item) => operationPath(item).endsWith(ext));
  assert.ok(operation, `${ext} operation should exist`);
  return operation;
}

function stringField(value: unknown, label: string): string {
  assert.ok(typeof value === 'string', `${label} should be a string`);
  return value;
}

test('runRecipe produces operations, run record, events, and indexes the run', () => {
  const trustedRoot = tempRoot();
  const runStoreRoot = path.join(trustedRoot, '.AgentCowork', 'runs');
  const runEvents = new RunEventBus();
  const runsIndex = new RunsIndex({ indexRoot: path.join(trustedRoot, '.AgentCowork', 'index') });

  const recipeId = firstRecipeId();
  const result = runRecipe({
    recipeId,
    trustedRoot,
    prompt: '测试运行',
    files: [],
    context: { tenantId: 'tenant_alice', userId: 'user_alice', traceId: 'trace_1' },
    runStoreRoot,
    runEvents,
    runsIndex,
  });

  assert.equal(result.ok, true);
  assert.match(result.runId, /^run_/);
  assert.ok(Array.isArray(result.operations));
  assert.ok(fs.existsSync(result.runPath), 'run record file written');

  // Event timeline shape.
  const types = result.events.map((e) => e.type);
  assert.ok(types.includes('user_message'));
  assert.ok(types.includes('assistant_start'));
  assert.ok(types.includes('preview'));
  assert.ok(types.includes('awaiting_approval'));
  assert.ok(types.includes('sources'));
  assert.equal(types[types.length - 1], 'assistant_end');
  // Events carry monotonic seq.
  for (let i = 1; i < result.events.length; i += 1) {
    assert.ok(Number(eventAt(result.events, i).seq) > Number(eventAt(result.events, i - 1).seq));
  }

  // Run record embeds events for replay across restart.
  const record = JSON.parse(fs.readFileSync(result.runPath, 'utf8')) as { events?: unknown[] };
  assert.ok(Array.isArray(record.events));
  assert.equal(record.events.length, result.events.length);

  // Indexed and tenant scoped.
  const listed = runsIndex.list({ tenantId: 'tenant_alice' });
  const firstListed = firstItem(listed, 'indexed run');
  assert.equal(listed.length, 1);
  assert.equal(firstListed.id, result.runId);
  assert.equal(runsIndex.list({ tenantId: 'tenant_bob' }).length, 0);
});

test('runRecipe throws 404 for unknown recipe', () => {
  const trustedRoot = tempRoot();
  assert.throws(
    () => runRecipe({
      recipeId: 'does-not-exist',
      trustedRoot,
      runStoreRoot: path.join(trustedRoot, '.AgentCowork', 'runs'),
    }),
    /Recipe not found/,
  );
});

test('runRecipe works without runEvents/runsIndex (events still numbered locally)', () => {
  const trustedRoot = tempRoot();
  const recipeId = firstRecipeId();
  const result = runRecipe({
    recipeId,
    trustedRoot,
    prompt: 'no deps',
    runStoreRoot: path.join(trustedRoot, '.AgentCowork', 'runs'),
  });
  assert.equal(result.ok, true);
  assert.ok(result.events.length >= 5);
  assert.equal(eventAt(result.events, 0).seq, 1);
});

test('summary-report recipe produces Office document artifacts', () => {
  const trustedRoot = tempRoot();
  const source = path.join(trustedRoot, 'notes.md');
  fs.writeFileSync(source, '# 项目状态\n- 已完成 P0\n- 风险：真实验收待补\n', 'utf8');

  const result = runRecipe({
    recipeId: 'summary-report',
    trustedRoot,
    prompt: '生成一页管理摘要',
    files: [source],
    runStoreRoot: path.join(trustedRoot, '.AgentCowork', 'runs'),
  });
  const paths = result.operations.map(operationPath);

  assert.ok(paths.some((item) => item.endsWith('.md')));
  assert.ok(paths.some((item) => item.endsWith('.docx')));
  assert.ok(paths.some((item) => item.endsWith('.pptx')));
  assert.ok(paths.some((item) => item.endsWith('.pdf')));
  for (const ext of ['.docx', '.pptx', '.pdf']) {
    const op = operationWithExt(result.operations, ext);
    assert.ok(op?.contentBase64, `${ext} operation carries base64 content`);
  }

  const docxOperation = operationWithExt(result.operations, '.docx');
  const docx = Buffer.from(stringField(docxOperation.contentBase64, 'docx contentBase64'), 'base64');
  const documentXml = readZipEntries(docx).find((entry) => entry.name === 'word/document.xml')?.content.toString('utf8') || '';
  assert.match(documentXml, /项目状态/);
});

test('captureRun extracts a redacted reusable recipe draft from an agent run', async () => {
  const root = tempRoot();
  const runStoreRoot = path.join(root, 'runs');
  const runId = 'run_capture_agent';
  const secret = 'sk-ABCDEFGHIJ1234567890';
  writeRunRecord(runStoreRoot, {
    id: runId,
    type: 'agent-chat',
    provider: 'kimi-api',
    mode: 'agent',
    status: 'succeeded',
    startedAt: '2026-05-24T00:00:00.000Z',
    finishedAt: '2026-05-24T00:00:01.000Z',
    input: { prompt: `写报告 api_key=${secret}` },
    result: { ok: true, text: `done ${secret}`, steps: [{ tool: 'Write', ok: true }] },
    events: [
      { type: 'tool_call', name: 'Write', args: { path: 'report.md', content: `token ${secret}` } },
      { type: 'tool_result', name: 'Write', status: 'succeeded', result: { path: path.join(root, 'report.md') } },
      { type: 'file_written', path: path.join(root, 'report.md') },
    ],
  });

  const draft = (await captureRun({ runId, runStoreRoot })).recipe;

  assert.equal(draft.draft, true);
  assert.equal(draft.sourceRunId, runId);
  assert.equal(draft.prompt.includes(secret), false);
  assert.equal(JSON.stringify(draft).includes(secret), false);
  assert.equal(draft.steps.length, 1);
  const firstStep = firstItem(draft.steps, 'captured step');
  assert.equal(firstStep.tool, 'Write');
  assert.equal(firstStep.status, 'succeeded');
  assert.equal(draft.artifacts.length, 1);
  assert.match(firstItem(draft.artifacts, 'captured artifact').path, /report\.md$/);
  assert.equal(draft.redacted, true);
});

test('captureRun falls back to runsIndex runPath when runStoreRoot has no record', async () => {
  const root = tempRoot();
  const primaryRunStore = path.join(root, 'primary-runs');
  const indexedRunStore = path.join(root, 'indexed-runs');
  const runsIndex = new RunsIndex({ indexRoot: path.join(root, 'index') });
  const runId = 'run_capture_indexed';
  const runPath = writeRunRecord(indexedRunStore, {
    id: runId,
    type: 'recipe-run',
    provider: 'agent-cowork-host',
    recipeId: 'summary-report',
    status: 'succeeded',
    startedAt: '2026-05-24T00:00:00.000Z',
    input: { prompt: '总结材料' },
    result: { ok: true, text: '生成总结报告' },
    events: [
      {
        type: 'preview',
        operations: [{ type: 'write', path: path.join(root, '.AgentCowork', 'artifacts', 'summary.md') }],
      },
    ],
  });
  runsIndex.upsert({ id: runId, runPath, type: 'recipe-run', status: 'succeeded' });

  const draft = (await captureRun({ runId, runStoreRoot: primaryRunStore, runsIndex })).recipe;

  assert.equal(draft.name, 'Captured summary-report');
  assert.equal(firstItem(draft.steps, 'captured recipe step').tool, 'recipe.operation');
  assert.equal(firstItem(draft.artifacts, 'captured recipe artifact').source, 'preview');
});
