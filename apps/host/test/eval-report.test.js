import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

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
