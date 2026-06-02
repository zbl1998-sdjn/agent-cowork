import test from 'node:test';
import assert from 'node:assert/strict';

type CiStep = { name: string };
type CiGatesModule = {
  shouldRunEvalForFiles(files: readonly string[]): boolean;
  buildCiSteps(options: { changedFiles: readonly string[] }): CiStep[];
};
const ciGatesScript = '../../../scripts/ci-gates.ts';

async function loadCiGates(): Promise<CiGatesModule> {
  return await import(ciGatesScript) as CiGatesModule;
}

test('CI eval gate triggers on prompt, model, and agent loop changes', async () => {
  const { shouldRunEvalForFiles } = await loadCiGates();

  assert.equal(shouldRunEvalForFiles(['apps/host/src/kimi/system-prompt.ts']), true);
  assert.equal(shouldRunEvalForFiles(['apps/host/src/kimi/system-prompt.js']), true);
  assert.equal(shouldRunEvalForFiles(['apps/host/src/kimi/model-call.ts']), true);
  assert.equal(shouldRunEvalForFiles(['apps/host/src/kimi/agent/tool-loop.ts']), true);
  assert.equal(shouldRunEvalForFiles(['docs/operator-notes.md']), false);
});

test('CI step builder adds eval when relevant changes are present or unknown', async () => {
  const { buildCiSteps } = await loadCiGates();

  assert.ok(buildCiSteps({ changedFiles: ['apps/host/src/kimi/agent-runner.ts'] }).some((step) => step.name === 'eval'));
  assert.ok(buildCiSteps({ changedFiles: [] }).some((step) => step.name === 'eval'));
  assert.ok(!buildCiSteps({ changedFiles: ['docs/operator-notes.md'] }).some((step) => step.name === 'eval'));
});
