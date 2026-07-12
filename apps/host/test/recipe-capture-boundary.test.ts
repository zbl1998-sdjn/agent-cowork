import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createServer } from '../src/server.js';
import { captureRun } from '../src/recipes/capture.js';
import { clearAtRestProtectorCache } from '../src/security/at-rest.js';
import { RunsIndex } from '../src/runtime/runs-index.js';
import { writeRunRecord } from '../src/runtime/run-store.js';
import {
  bind,
  close,
  jsonRequest,
  objectField,
  stringField,
  tempRoot,
} from './helpers/host-http.js';

const OWNER_HEADERS = {
  'x-tenant-id': 'tenant_alice',
  'x-user-id': 'user_alice',
};

test('captureRun authorizes the run before invoking its injected record reader', async () => {
  let readerCalls = 0;

  await assert.rejects(
    () => captureRun({
      runId: 'run_not_owned',
      runsIndex: { get: () => null },
      recordReader: () => {
        readerCalls += 1;
        return {
          type: 'recipe-run',
          status: 'succeeded',
          input: { prompt: 'must stay unread' },
        };
      },
    }),
    (error: unknown) => (
      error instanceof Error
      && (error as Error & { statusCode?: number }).statusCode === 404
    ),
  );
  assert.equal(readerCalls, 0, 'an unauthorized run must not reach storage');
});

test('capture route ignores an indexed runPath and reads the canonical run by id', async () => {
  const trustedRoot = tempRoot('kcw-capture-index-path-');
  const runStoreRoot = path.join(trustedRoot, '.AgentCowork', 'runs');
  const indexRoot = path.join(trustedRoot, '.AgentCowork', 'index');
  const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-capture-external-'));
  const externalRunPath = path.join(externalRoot, 'outside.json');
  const maliciousSecret = 'test-index-path-must-not-be-read';
  const runId = 'run_capture_index_path';

  fs.writeFileSync(externalRunPath, JSON.stringify({
    type: 'malicious-external-record',
    status: 'succeeded',
    input: { prompt: maliciousSecret },
    result: { text: maliciousSecret },
  }), 'utf8');
  writeRunRecord(runStoreRoot, {
    id: runId,
    type: 'recipe-run',
    status: 'succeeded',
    recipeId: 'email-draft',
    context: { tenantId: 'tenant_alice', userId: 'user_alice' },
    input: { prompt: 'canonical prompt' },
    result: { text: 'canonical result' },
  });
  const runsIndex = new RunsIndex({ indexRoot });
  runsIndex.upsert({
    id: runId,
    runPath: externalRunPath,
    type: 'recipe-run',
    status: 'succeeded',
    tenantId: 'tenant_alice',
    userId: 'user_alice',
  });

  const server = createServer({
    trustedRoot,
    runsIndex,
    enableScheduler: false,
    requireAuth: false,
    trustIdentityHeaders: true,
  });
  const base = await bind(server);
  try {
    const captured = await jsonRequest(base, '/api/recipes/capture', {
      method: 'POST',
      headers: OWNER_HEADERS,
      body: { runId },
    });
    assert.equal(captured.status, 200);
    const recipe = objectField(captured.body, 'recipe', 'captured recipe');
    assert.equal(recipe.name, 'Captured email-draft');
    assert.equal(recipe.prompt, 'canonical prompt');
    assert.equal(JSON.stringify(recipe).includes(maliciousSecret), false);

    const sibling = await jsonRequest(base, '/api/recipes/capture', {
      method: 'POST',
      headers: { ...OWNER_HEADERS, 'x-user-id': 'user_sibling' },
      body: { runId },
    });
    assert.equal(sibling.status, 404);
  } finally {
    await close(server);
  }
});

test('capture route reads an encrypted canonical run through the run-store boundary', async () => {
  const trustedRoot = tempRoot('kcw-capture-encrypted-');
  const previousEncryption = process.env.KCW_ENCRYPT_AT_REST;
  process.env.KCW_ENCRYPT_AT_REST = '1';
  clearAtRestProtectorCache();
  const server = createServer({
    trustedRoot,
    enableScheduler: false,
    requireAuth: false,
    trustIdentityHeaders: true,
  });
  const base = await bind(server);
  try {
    const run = await jsonRequest(base, '/api/recipes/email-draft/run', {
      method: 'POST',
      headers: { ...OWNER_HEADERS, 'idempotency-key': 'encrypted-capture-source' },
      body: { prompt: 'encrypted canonical prompt', files: [] },
    });
    assert.equal(run.status, 200);
    const runId = stringField(run.body, 'runId', 'encrypted run id');
    const runPath = stringField(run.body, 'runPath', 'encrypted run path');
    assert.match(fs.readFileSync(runPath, 'utf8'), /^aesgcm:v1:/);

    const captured = await jsonRequest(base, '/api/recipes/capture', {
      method: 'POST',
      headers: OWNER_HEADERS,
      body: { runId },
    });
    assert.equal(captured.status, 200);
    const recipe = objectField(captured.body, 'recipe', 'encrypted captured recipe');
    assert.equal(recipe.prompt, 'encrypted canonical prompt');
  } finally {
    await close(server);
    if (previousEncryption === undefined) delete process.env.KCW_ENCRYPT_AT_REST;
    else process.env.KCW_ENCRYPT_AT_REST = previousEncryption;
    clearAtRestProtectorCache();
  }
});
