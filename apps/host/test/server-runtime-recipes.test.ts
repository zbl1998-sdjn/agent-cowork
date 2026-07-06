import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createServer } from '../src/server.js';
import {
  arrayField,
  bind,
  close,
  jsonRequest,
  objectField,
  present,
  recordValue,
  stringField,
  tempRoot,
} from './helpers/host-http.js';

// meeting-actions 是转换型配方(requiresSources):测试运行前先在工作区铺一份会议纪要来源。
function seedMeetingNotes(trustedRoot: string): string {
  const sourcePath = path.join(trustedRoot, 'meeting-notes.md');
  fs.writeFileSync(sourcePath, '# 会议纪要\n- 跟进采购合同\n- 汇总发票和付款周期\n', 'utf8');
  return sourcePath;
}

test('runs index: recipe-run upserts a tenant-scoped record', async () => {
  const trustedRoot = tempRoot();
  const server = createServer({ trustedRoot, enableScheduler: false });
  const base = await bind(server);
  try {
    const indexEmpty = await jsonRequest(base, '/api/runs/index', {
      headers: { 'x-tenant-id': 'tenant_alice' },
    });
    assert.equal(indexEmpty.status, 200);
    assert.equal(arrayField(indexEmpty.body, 'runs', 'empty runs index').length, 0);

    const recipeRun = await jsonRequest(base, '/api/recipes/meeting-actions/run', {
      method: 'POST',
      headers: { 'x-tenant-id': 'tenant_alice', 'x-user-id': 'user_alice', 'idempotency-key': 'index-run' },
      body: { prompt: '把会议纪要整理', files: [seedMeetingNotes(trustedRoot)] },
    });
    assert.equal(recipeRun.status, 200);
    assert.ok(stringField(recipeRun.body, 'runId', 'recipe run id'));

    const indexFilled = await jsonRequest(base, '/api/runs/index', {
      headers: { 'x-tenant-id': 'tenant_alice' },
    });
    assert.equal(indexFilled.status, 200);
    const filledRuns = arrayField(indexFilled.body, 'runs', 'filled runs index');
    const firstRun = present(filledRuns[0], 'first indexed run');
    assert.equal(filledRuns.length, 1);
    assert.equal(firstRun.recipeId, 'meeting-actions');
    assert.equal(firstRun.status, 'succeeded');
    assert.equal(firstRun.tenantId, 'tenant_alice');

    const otherTenant = await jsonRequest(base, '/api/runs/index', {
      headers: { 'x-tenant-id': 'tenant_bob' },
    });
    assert.equal(arrayField(otherTenant.body, 'runs', 'other tenant runs').length, 0, 'tenant scoping must hold');
  } finally {
    await close(server);
  }
});

test('recipe capture route returns a tenant-scoped redacted draft', async () => {
  const trustedRoot = tempRoot();
  const server = createServer({
    trustedRoot,
    enableScheduler: false,
    requireAuth: false,
    trustIdentityHeaders: true,
  });
  const base = await bind(server);
  try {
    const secret = 'sk-ABCDEFGHIJ1234567890';
    const recipeRun = await jsonRequest(base, '/api/recipes/meeting-actions/run', {
      method: 'POST',
      headers: {
        'x-tenant-id': 'tenant_alice',
        'x-user-id': 'user_alice',
        'idempotency-key': 'capture-run-source',
      },
      body: { prompt: `把会议纪要整理 api_key=${secret}`, files: [seedMeetingNotes(trustedRoot)] },
    });
    assert.equal(recipeRun.status, 200);
    const recipeRunId = stringField(recipeRun.body, 'runId', 'captured source run id');
    assert.ok(recipeRunId);

    const captured = await jsonRequest(base, '/api/recipes/capture', {
      method: 'POST',
      headers: { 'x-tenant-id': 'tenant_alice', 'x-user-id': 'user_alice' },
      body: { runId: recipeRunId },
    });
    assert.equal(captured.status, 200);
    const capturedRecipe = objectField(captured.body, 'recipe', 'captured recipe');
    assert.equal(capturedRecipe.draft, true);
    assert.equal(capturedRecipe.sourceRunId, recipeRunId);
    assert.equal(capturedRecipe.redacted, true);
    assert.ok(arrayField(capturedRecipe, 'steps', 'captured recipe steps').length > 0);
    assert.equal(JSON.stringify(capturedRecipe).includes(secret), false);

    const otherTenant = await jsonRequest(base, '/api/recipes/capture', {
      method: 'POST',
      headers: { 'x-tenant-id': 'tenant_bob', 'x-user-id': 'user_bob' },
      body: { runId: recipeRunId },
    });
    assert.equal(otherTenant.status, 404);

    const invalid = await jsonRequest(base, '/api/recipes/capture', {
      method: 'POST',
      body: { runId: '../escape' },
    });
    assert.equal(invalid.status, 400);
  } finally {
    await close(server);
  }
});

test('custom recipes save redacted drafts and run tenant-scoped recipes', async () => {
  const trustedRoot = tempRoot();
  const server = createServer({
    trustedRoot,
    enableScheduler: false,
    requireAuth: false,
    trustIdentityHeaders: true,
  });
  const base = await bind(server);
  try {
    const draft = {
      name: 'Captured meeting-actions',
      description: '整理会议纪要',
      prompt: '整理会议纪要',
      sourceRunId: 'run_custom_source',
      redacted: true,
      steps: [{ index: 0, tool: 'recipe.operation', status: 'previewed' }],
      artifacts: [{ path: 'notes.md', kind: 'file' }],
    };
    const saved = await jsonRequest(base, '/api/recipes/custom', {
      method: 'POST',
      headers: {
        'x-tenant-id': 'tenant_alice',
        'x-user-id': 'user_alice',
        'idempotency-key': 'custom-recipe-save',
      },
      body: { recipe: draft },
    });
    assert.equal(saved.status, 200);
    const savedRecipe = objectField(saved.body, 'recipe', 'saved custom recipe');
    const savedRecipeId = stringField(savedRecipe, 'id', 'saved custom recipe id');
    assert.match(savedRecipeId, /^custom-/);
    assert.equal(savedRecipe.custom, true);
    assert.equal(savedRecipe.tenantId, 'tenant_alice');

    const listed = await jsonRequest(base, '/api/recipes', {
      headers: { 'x-tenant-id': 'tenant_alice', 'x-user-id': 'user_alice' },
    });
    assert.equal(listed.status, 200);
    assert.ok(arrayField(listed.body, 'recipes', 'listed recipes').some((recipe) => recipe.id === savedRecipeId));

    const otherTenant = await jsonRequest(base, '/api/recipes', {
      headers: { 'x-tenant-id': 'tenant_bob', 'x-user-id': 'user_bob' },
    });
    assert.equal(arrayField(otherTenant.body, 'recipes', 'other tenant recipes').some((recipe) => recipe.id === savedRecipeId), false);

    const run = await jsonRequest(base, `/api/recipes/${encodeURIComponent(savedRecipeId)}/run`, {
      method: 'POST',
      headers: {
        'x-tenant-id': 'tenant_alice',
        'x-user-id': 'user_alice',
        'idempotency-key': 'custom-recipe-run',
      },
      body: { prompt: '用这个技能生成结果', files: [] },
    });
    assert.equal(run.status, 200);
    const runRecipe = objectField(run.body, 'recipe', 'custom recipe run recipe');
    const operations = arrayField(run.body, 'operations', 'custom recipe operations');
    const firstOperation = present(operations[0], 'first custom recipe operation');
    assert.equal(runRecipe.id, savedRecipeId);
    assert.equal(runRecipe.output, 'DOCX + TXT');
    assert.equal(operations.length, 3);
    assert.match(String(firstOperation.path), /custom-/);
    assert.ok(operations.some((operation) => String(recordValue(operation, 'operation').path).endsWith('.txt')));
    assert.ok(operations.some((operation) => String(recordValue(operation, 'operation').path).endsWith('.docx')));
    assert.ok(operations.some((operation) => String(recordValue(operation, 'operation').path).endsWith('.pdf')));

    const unsafe = await jsonRequest(base, '/api/recipes/custom', {
      method: 'POST',
      headers: { 'idempotency-key': 'custom-recipe-unsafe' },
      body: { recipe: { name: 'Unsafe draft', redacted: false } },
    });
    assert.equal(unsafe.status, 400);

    const malformedCustom = await jsonRequest(base, '/api/recipes/custom', {
      method: 'POST',
      body: { recipe: ['not-valid'] },
    });
    assert.equal(malformedCustom.status, 400);

    const malformedRun = await jsonRequest(base, `/api/recipes/${encodeURIComponent(savedRecipeId)}/run`, {
      method: 'POST',
      body: { prompt: '用这个技能生成结果', files: { path: 'notes.md' } },
    });
    assert.equal(malformedRun.status, 400);
  } finally {
    await close(server);
  }
});

test('recipe template import enforces strict format and runs uploaded markdown body', async () => {
  const trustedRoot = tempRoot();
  const server = createServer({
    trustedRoot,
    enableScheduler: false,
    requireAuth: false,
    trustIdentityHeaders: true,
  });
  const base = await bind(server);
  try {
    const template = {
      schemaVersion: 1,
      id: 'strict-weekly-template',
      name: '严格周报模板',
      description: '按用户上传模板输出周报',
      prompt: '请按固定模板输出',
      output: 'Markdown',
      riskLevel: 'safe-write',
      requiresSources: false,
      redacted: true,
      format: {
        kind: 'markdown',
        body: '# {{recipe.name}}\n\n## 指令\n{{prompt}}\n\n## 来源\n{{sources}}\n\n## 摘要\n{{source_excerpt}}\n',
      },
      steps: [{ index: 0, tool: 'template.render', status: 'ready' }],
      artifacts: [{ path: 'weekly.md', kind: 'markdown' }],
    };
    const imported = await jsonRequest(base, '/api/recipes/import', {
      method: 'POST',
      headers: {
        'x-tenant-id': 'tenant_alice',
        'x-user-id': 'user_alice',
        'idempotency-key': 'strict-template-import',
      },
      body: { template },
    });
    assert.equal(imported.status, 200);
    const importedRecipe = objectField(imported.body, 'recipe', 'imported recipe');
    assert.equal(importedRecipe.id, 'strict-weekly-template');
    assert.equal(importedRecipe.requiresSources, false);
    assert.equal(objectField(importedRecipe, 'format', 'imported recipe format').body, template.format.body);

    const listed = await jsonRequest(base, '/api/recipes', {
      headers: { 'x-tenant-id': 'tenant_alice', 'x-user-id': 'user_alice' },
    });
    assert.ok(arrayField(listed.body, 'recipes', 'listed recipes').some((recipe) => recipe.id === 'strict-weekly-template'));

    const run = await jsonRequest(base, '/api/recipes/strict-weekly-template/run', {
      method: 'POST',
      headers: {
        'x-tenant-id': 'tenant_alice',
        'x-user-id': 'user_alice',
        'idempotency-key': 'strict-template-run',
      },
      body: { prompt: '本周完成模板上传', files: [] },
    });
    assert.equal(run.status, 200);
    const operation = recordValue(present(arrayField(run.body, 'operations', 'strict template operations')[0], 'strict template operation'), 'strict template operation');
    const content = String(operation.content || '');
    assert.match(String(operation.path), /strict-weekly-template-/);
    assert.match(content, /^# 严格周报模板/);
    assert.match(content, /## 指令\n本周完成模板上传/);
    assert.match(content, /## 来源\n- 未提供可读取来源文件/);
    assert.doesNotMatch(content, /## 处理结果/);

    const invalid = await jsonRequest(base, '/api/recipes/import', {
      method: 'POST',
      headers: { 'idempotency-key': 'strict-template-invalid' },
      body: { template: { ...template, extra: 'not allowed' } },
    });
    assert.equal(invalid.status, 400);
    assert.match(String(invalid.body.error), /Unrecognized|unrecognized|template|field|key/);
  } finally {
    await close(server);
  }
});

test('recipe run endpoint replays duplicate idempotency key without creating a second run', async () => {
  const trustedRoot = tempRoot();
  const server = createServer({ trustedRoot, enableScheduler: false });
  const base = await bind(server);
  try {
    const headers = {
      'x-tenant-id': 'tenant_alice',
      'x-user-id': 'user_alice',
      'idempotency-key': 'recipe-run-once',
    };
    const sourceFiles = [seedMeetingNotes(trustedRoot)];
    const first = await jsonRequest(base, '/api/recipes/meeting-actions/run', {
      method: 'POST',
      headers,
      body: { prompt: '把会议纪要整理', files: sourceFiles },
    });
    assert.equal(first.status, 200);
    const firstRunId = stringField(first.body, 'runId', 'first recipe run id');
    assert.ok(firstRunId);
    assert.equal(first.body.idempotentReplay, undefined);

    const second = await jsonRequest(base, '/api/recipes/meeting-actions/run', {
      method: 'POST',
      headers,
      body: { prompt: '把会议纪要整理', files: sourceFiles },
    });
    assert.equal(second.status, 200);
    assert.equal(second.body.idempotentReplay, true);
    assert.equal(second.body.runId, firstRunId);

    const index = await jsonRequest(base, '/api/runs/index', {
      headers: { 'x-tenant-id': 'tenant_alice' },
    });
    assert.equal(arrayField(index.body, 'runs', 'replayed recipe runs').length, 1);
    assert.equal(objectField(index.body, 'stats', 'replayed recipe stats').total, 1);
  } finally {
    await close(server);
  }
});

test('recipe run invalid route id returns 400', async () => {
  const trustedRoot = tempRoot();
  const server = createServer({ trustedRoot, enableScheduler: false });
  const base = await bind(server);
  try {
    const response = await fetch(`${base}/api/recipes/bad%2Fid/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'bad-recipe-id' },
      body: JSON.stringify({ prompt: 'x', files: [] }),
    });
    assert.equal(response.status, 400);
    const body = recordValue(await response.json(), 'invalid recipe id response');
    assert.match(String(body.error), /Invalid recipe id/);
  } finally {
    await close(server);
  }
});

test('recipe run rejects malformed body before executing the recipe', async () => {
  const trustedRoot = tempRoot();
  const server = createServer({ trustedRoot, enableScheduler: false });
  const base = await bind(server);
  try {
    const response = await jsonRequest(base, '/api/recipes/meeting-actions/run', {
      method: 'POST',
      headers: { 'idempotency-key': 'bad-recipe-body' },
      body: { prompt: 'x', files: 'not-an-array' },
    });
    assert.equal(response.status, 400);
    assert.match(String(response.body.error), /files must be an array/);
  } finally {
    await close(server);
  }
});
