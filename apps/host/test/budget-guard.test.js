import test from 'node:test';
import assert from 'node:assert/strict';
import { createBudgetGuard } from '../src/runtime/budget-guard.js';

test('budget guard aborts when run token budget is exceeded', () => {
  const guard = createBudgetGuard({ maxRunTokens: 10, model: 'fake' });

  let decision = guard.recordUsage({ prompt_tokens: 4, completion_tokens: 4, total_tokens: 8 });
  assert.equal(decision.shouldAbort, false);

  decision = guard.recordUsage({ prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 });
  assert.equal(decision.shouldAbort, true);
  assert.equal(decision.limit, 'maxRunTokens');
  assert.equal(decision.actual, 11);
  assert.match(guard.stopMessage(decision), /token budget/i);
});

test('budget guard combines previous session usage with run usage', () => {
  const guard = createBudgetGuard({
    maxSessionTokens: 15,
    sessionUsage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
  });

  const decision = guard.recordUsage({ prompt_tokens: 3, completion_tokens: 3, total_tokens: 6 });
  assert.equal(decision.shouldAbort, true);
  assert.equal(decision.limit, 'maxSessionTokens');
  assert.equal(decision.actual, 16);
});

test('budget guard enforces estimated cost and wall-clock limits', () => {
  const guard = createBudgetGuard({
    maxRunCostUsd: 0.01,
    maxWallClockMs: 100,
    model: 'expensive-model',
    pricing: {
      default: { inputUsdPerMillionTokens: 0, outputUsdPerMillionTokens: 0 },
      'expensive-model': { inputUsdPerMillionTokens: 100, outputUsdPerMillionTokens: 100 },
    },
    now: () => 1_000,
  });

  const costDecision = guard.recordUsage({ prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 });
  assert.equal(costDecision.shouldAbort, true);
  assert.equal(costDecision.limit, 'maxRunCostUsd');
  assert.equal(costDecision.actual, 0.02);

  const wallGuard = createBudgetGuard({ maxWallClockMs: 100, startedAtMs: 1_000, now: () => 1_101 });
  const wallDecision = wallGuard.check();
  assert.equal(wallDecision.shouldAbort, true);
  assert.equal(wallDecision.limit, 'maxWallClockMs');
  assert.equal(wallDecision.actual, 101);
});
