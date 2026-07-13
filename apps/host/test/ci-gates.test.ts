import test from 'node:test';
import assert from 'node:assert/strict';

type CiStep = {
  name: string;
  timeoutMs: number;
  env?: Readonly<Record<string, string>>;
  parallelGroup?: string;
};
type CiGatesModule = {
  shouldRunEvalForFiles(files: readonly string[]): boolean;
  buildCiSteps(options: { changedFiles: readonly string[] }): CiStep[];
  ciStepEnvironment(step: CiStep, env?: Record<string, string | undefined>): Record<string, string | undefined>;
};
const ciGatesScript = '../../../scripts/ci-gates.ts';

async function loadCiGates(): Promise<CiGatesModule> {
  return await import(ciGatesScript) as CiGatesModule;
}

test('CI eval gate triggers on prompt, model, and agent loop changes', async () => {
  const { shouldRunEvalForFiles } = await loadCiGates();

  assert.equal(shouldRunEvalForFiles(['apps/host/src/engine/system-prompt.ts']), true);
  assert.equal(shouldRunEvalForFiles(['apps/host/src/engine/system-prompt.js']), true);
  assert.equal(shouldRunEvalForFiles(['apps/host/src/engine/model-call.ts']), true);
  assert.equal(shouldRunEvalForFiles(['apps/host/src/engine/agent/tool-loop.ts']), true);
  assert.equal(shouldRunEvalForFiles(['docs/operator-notes.md']), false);
});

test('CI step builder adds eval when relevant changes are present or unknown', async () => {
  const { buildCiSteps, ciStepEnvironment } = await loadCiGates();

  const evalStep = buildCiSteps({ changedFiles: ['apps/host/src/engine/agent-runner.ts'] })
    .find((step) => step.name === 'eval');
  assert.ok(evalStep);
  assert.equal(
    ciStepEnvironment(evalStep, {}).KCW_EVAL_REPLAY_RECORDS,
    'eval/fixtures/ci-model-records.json',
  );
  assert.equal(
    buildCiSteps({ changedFiles: [] }).some((step) => step.name === 'eval'),
    true,
  );
  assert.ok(!buildCiSteps({ changedFiles: ['docs/operator-notes.md'] }).some((step) => step.name === 'eval'));
});

test('CI eval step preserves an explicit parent replay fixture', async () => {
  const { buildCiSteps, ciStepEnvironment } = await loadCiGates();
  const evalStep = buildCiSteps({ changedFiles: ['apps/host/src/engine/agent-runner.ts'] })
    .find((step) => step.name === 'eval');
  assert.ok(evalStep);
  const explicitReplay = 'output/eval-replay/override.json';

  assert.equal(
    ciStepEnvironment(evalStep, { KCW_EVAL_REPLAY_RECORDS: explicitReplay }).KCW_EVAL_REPLAY_RECORDS,
    explicitReplay,
  );
});

test('CI source gate runs host tests through the enforced coverage command exactly once', async () => {
  const { buildCiSteps } = await loadCiGates();
  const steps = buildCiSteps({ changedFiles: ['docs/operator-notes.md'] });

  assert.deepEqual(steps.map((step) => step.name), [
    'check',
    'test:host:coverage:90',
    'test:ui',
  ]);
  assert.deepEqual(steps.map((step) => step.parallelGroup), ['source-gates', 'source-gates', 'source-gates']);
  assert.ok(steps.every((step) => Number.isInteger(step.timeoutMs) && step.timeoutMs > 0));
});
