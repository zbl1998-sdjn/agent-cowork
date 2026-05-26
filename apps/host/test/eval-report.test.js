import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('Eval report emits JSON, HTML, and baseline regression metadata', async () => {
  const { generateEvalReport } = await import('../../../eval/report.js');
  const report = generateEvalReport({
    totalTasks: 2,
    passedTasks: 1,
    failedTasks: 1,
    passRate: 0.5,
    results: [
      { taskId: 'passing-task', score: { passed: true, score: 1, dimensions: {} } },
      { taskId: 'failing-task', score: { passed: false, score: 0, dimensions: {} } },
    ],
  }, {
    baseline: { passRate: 0.75 },
    regressionTolerance: 0.05,
    generatedAt: '2026-01-01T00:00:00.000Z',
  });

  assert.equal(report.json.generatedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(report.json.summary.passRate, 0.5);
  assert.equal(report.json.baseline.delta, -0.25);
  assert.equal(report.json.baseline.regressed, true);
  assert.match(report.html, /Eval Report/);
  assert.match(report.html, /passing-task/);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(report.json)));
});

test('package exposes npm run eval command', () => {
  const pkg = JSON.parse(fs.readFileSync('../../package.json', 'utf8'));
  assert.equal(pkg.scripts.eval, 'node scripts/eval.mjs');
});

test('eval executor requires replay records by default', async () => {
  const { createEvalExecutorFromEnv } = await import('../../../scripts/eval.mjs');

  assert.throws(
    () => createEvalExecutorFromEnv({ recordsPath: null, allowContractExecutor: false }),
    (error) => error.code === 'EVAL_REPLAY_RECORDS_REQUIRED' && /KCW_EVAL_REPLAY_RECORDS/.test(error.message),
  );
});

test('eval contract executor is explicit opt-in only', async () => {
  const { createEvalExecutorFromEnv } = await import('../../../scripts/eval.mjs');
  const { mode, executor } = createEvalExecutorFromEnv({ recordsPath: null, allowContractExecutor: true });

  assert.equal(mode, 'contract');
  const result = await executor({
    task: {
      id: 'contract-dry-run',
      fixture: { files: [] },
      assertions: [{ type: 'responseContains', contains: 'dry run ok' }],
      maxSteps: 2,
    },
  });

  assert.equal(result.response, 'dry run ok');
});

test('eval replay records loader accepts JSONL ModelRecorder files', async () => {
  const { readReplayRecords } = await import('../../../scripts/eval.mjs');
  const filePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-eval-records-')), 'records.jsonl');
  fs.writeFileSync(
    filePath,
    [
      JSON.stringify({ kind: 'model-call', status: 'succeeded', fingerprint: 'sha256:one', response: { content: 'one' } }),
      JSON.stringify({ kind: 'model-call', status: 'failed', fingerprint: 'sha256:two', error: { message: 'nope' } }),
    ].join('\n'),
    'utf8',
  );

  const records = readReplayRecords(filePath);

  assert.equal(records.length, 2);
  assert.equal(records[0].fingerprint, 'sha256:one');
});
