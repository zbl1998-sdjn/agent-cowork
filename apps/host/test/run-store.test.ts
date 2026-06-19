import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createRunId,
  getRunPath,
  listRunRecords,
  readRunRecord,
  writeRunRecord,
} from '../src/runtime/run-store.js';

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-run-store-'));
}

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

test('run store validates ids before resolving persisted run paths', () => {
  const root = tempRoot();

  assert.equal(
    createRunId(new Date('2026-06-19T13:00:01.123Z'), { randomHex: (length) => 'a'.repeat(length) }),
    'run_20260619130001_aaaaaaaa',
  );
  assert.equal(getRunPath(root, 'run_valid-1'), path.join(root, 'run_valid-1.json'));
  assert.throws(() => getRunPath(root, '../escape'), /Invalid run id/);
  assert.throws(() => readRunRecord(root, 'bad/path'), /Invalid run id/);
  assert.equal(readRunRecord(root, 'run_missing'), null);
});

test('listRunRecords summarizes persisted runs, skips corrupt files, and keeps newest first', () => {
  const root = path.join(tempRoot(), 'runs');
  fs.mkdirSync(root, { recursive: true });
  assert.deepEqual(listRunRecords(path.join(root, 'missing')), []);

  writeRunRecord(root, {
    id: 'run_old',
    type: 'agent-chat',
    status: 'failed',
    provider: 'kimi-api',
    mode: 'agent',
    tenantId: 'tenant_fallback',
    userId: 'user_fallback',
    traceId: 'trace_fallback',
    startedAt: '2026-06-19T11:00:00.000Z',
    finishedAt: '2026-06-19T11:00:05.000Z',
    durationMs: 5000,
    input: { prompt: 'old prompt' },
    error: { message: 'old failed' },
  });
  writeJson(path.join(root, 'run_new.json'), {
    id: 'run_new',
    type: 'recipe',
    status: 'succeeded',
    provider: 'agent-cowork-host',
    mode: 'recipe',
    recipeId: 'daily-review',
    context: { tenantId: 'tenant_ctx', userId: 'user_ctx', traceId: 'trace_ctx' },
    tenantId: 'tenant_should_not_win',
    userId: 'user_should_not_win',
    traceId: 'trace_should_not_win',
    startedAt: '2026-06-19T12:00:00.000Z',
    finishedAt: '2026-06-19T12:00:01.000Z',
    durationMs: 1000,
    input: { prompt: 'new prompt' },
    error: { message: 'ignored success detail' },
  });
  fs.writeFileSync(path.join(root, 'run_corrupt.json'), '{not-json', 'utf8');
  fs.writeFileSync(path.join(root, 'note.txt'), 'ignore me', 'utf8');
  fs.mkdirSync(path.join(root, 'run_dir.json'));

  const all = listRunRecords(root, { limit: 10 });
  assert.deepEqual(
    all.map((record) => record.id),
    ['run_new', 'run_old'],
  );
  assert.equal(all[0]?.tenantId, 'tenant_ctx');
  assert.equal(all[0]?.userId, 'user_ctx');
  assert.equal(all[0]?.traceId, 'trace_ctx');
  assert.equal(all[0]?.recipeId, 'daily-review');
  assert.equal(all[0]?.prompt, 'new prompt');
  assert.equal(all[0]?.error, 'ignored success detail');
  assert.equal(all[1]?.tenantId, 'tenant_fallback');
  assert.equal(all[1]?.userId, 'user_fallback');
  assert.equal(all[1]?.traceId, 'trace_fallback');
  assert.match(all[0]?.path ?? '', /run_new\.json$/);

  assert.deepEqual(
    listRunRecords(root, { limit: 1 }).map((record) => record.id),
    ['run_new'],
  );
});
