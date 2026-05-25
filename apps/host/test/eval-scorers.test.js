import test from 'node:test';
import assert from 'node:assert/strict';

const TASK = {
  id: 'file-read-contract-summary',
  title: 'Read a contract and summarize obligations',
  category: 'file-read',
  prompt: 'Read contract.txt and summarize the renewal date and payment obligation.',
  maxSteps: 4,
  fixture: {
    files: [{ path: 'contract.txt', content: 'Renewal date: 2026-07-01\n' }],
  },
  assertions: [
    { type: 'responseContains', contains: '2026-07-01' },
    { type: 'toolCalled', tool: 'Read' },
    { type: 'fileExists', path: 'contract.txt' },
  ],
};

test('Eval scorer emits structured multidimensional JSON for a passing task', async () => {
  const { scoreEvalTaskResult } = await import('../../../eval/scorers/index.js');
  const score = scoreEvalTaskResult(TASK, {
    response: 'The renewal date is 2026-07-01.',
    files: { 'contract.txt': 'Renewal date: 2026-07-01\n' },
    toolCalls: [{ name: 'Read' }],
    steps: 3,
    latencyMs: 1200,
    usage: { inputTokens: 80, outputTokens: 40, totalTokens: 120, costUsd: 0.0003 },
  }, {
    latencyBudgetMs: 2000,
    tokenBudget: 500,
    costBudgetUsd: 0.01,
  });

  assert.equal(score.taskId, TASK.id);
  assert.equal(score.passed, true);
  assert.equal(score.dimensions.success.passedAssertions, 3);
  assert.equal(score.dimensions.success.failedAssertions.length, 0);
  assert.equal(score.dimensions.efficiency.toolCalls, 1);
  assert.equal(score.dimensions.steps.steps, 3);
  assert.equal(score.dimensions.latency.latencyMs, 1200);
  assert.equal(score.dimensions.tokens.totalTokens, 120);
  assert.equal(score.dimensions.cost.costUsd, 0.0003);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(score)));
});

test('Eval scorer reports deterministic assertion failures and failed pass state', async () => {
  const { createDefaultScorer } = await import('../../../eval/scorers/index.js');
  const scorer = createDefaultScorer();
  const score = scorer.score(TASK, {
    response: 'No date found.',
    files: {},
    toolCalls: [],
    steps: 5,
    latencyMs: 3000,
    usage: { totalTokens: 900, costUsd: 0.02 },
  }, {
    latencyBudgetMs: 2000,
    tokenBudget: 500,
    costBudgetUsd: 0.01,
  });

  assert.equal(score.passed, false);
  assert.equal(score.dimensions.success.passedAssertions, 0);
  assert.deepEqual(
    score.dimensions.success.failedAssertions.map((failure) => failure.type),
    ['responseContains', 'toolCalled', 'fileExists'],
  );
  assert.equal(score.dimensions.steps.withinLimit, false);
  assert.equal(score.dimensions.latency.withinBudget, false);
  assert.equal(score.dimensions.tokens.withinBudget, false);
  assert.equal(score.dimensions.cost.withinBudget, false);
});
