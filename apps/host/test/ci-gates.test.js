import test from 'node:test';
import assert from 'node:assert/strict';

test('CI eval gate triggers on prompt, model, and agent loop changes', async () => {
  const { shouldRunEvalForFiles } = await import('../../../scripts/ci-gates.mjs');

  assert.equal(shouldRunEvalForFiles(['apps/host/src/kimi/system-prompt.js']), true);
  assert.equal(shouldRunEvalForFiles(['apps/host/src/kimi/model-call.js']), true);
  assert.equal(shouldRunEvalForFiles(['apps/host/src/kimi/agent/tool-loop.js']), true);
  assert.equal(shouldRunEvalForFiles(['docs/operator-notes.md']), false);
});

test('CI step builder adds eval when relevant changes are present or unknown', async () => {
  const { buildCiSteps } = await import('../../../scripts/ci-gates.mjs');

  assert.ok(buildCiSteps({ changedFiles: ['apps/host/src/kimi/agent-runner.js'] }).some((step) => step.name === 'eval'));
  assert.ok(buildCiSteps({ changedFiles: [] }).some((step) => step.name === 'eval'));
  assert.ok(!buildCiSteps({ changedFiles: ['docs/operator-notes.md'] }).some((step) => step.name === 'eval'));
});
