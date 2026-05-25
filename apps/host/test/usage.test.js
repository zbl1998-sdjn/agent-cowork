import assert from 'node:assert/strict';
import test from 'node:test';
import {
  aggregateTokenUsage,
  breakdownDuration,
  buildUsageTransparency,
  estimateTokenCost,
  normalizeTokenUsage,
} from '../src/runtime/usage.js';

test('normalizeTokenUsage accepts provider aliases and never returns negative values', () => {
  assert.deepEqual(normalizeTokenUsage({
    input_tokens: 12.4,
    output_tokens: 7.2,
    total_tokens: -1,
  }), {
    prompt_tokens: 12,
    completion_tokens: 7,
    total_tokens: 19,
  });
});

test('aggregateTokenUsage sums multiple model-call usage objects', () => {
  assert.deepEqual(aggregateTokenUsage([
    { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
    { promptTokens: 2, completionTokens: 5 },
    null,
  ]), {
    prompt_tokens: 12,
    completion_tokens: 8,
    total_tokens: 20,
  });
});

test('estimateTokenCost uses local pricing without secrets', () => {
  const cost = estimateTokenCost(
    { prompt_tokens: 1_000_000, completion_tokens: 500_000 },
    {
      model: 'local-test',
      pricing: {
        default: { inputUsdPerMillionTokens: 0, outputUsdPerMillionTokens: 0 },
        'local-test': { inputUsdPerMillionTokens: 2, outputUsdPerMillionTokens: 6 },
      },
    },
  );

  assert.equal(cost.total, 5);
  assert.equal(cost.input, 2);
  assert.equal(cost.output, 3);
  assert.equal(cost.source, 'local-estimate');
  assert.equal(cost.estimated, true);
});

test('estimateTokenCost can use provider-specific pricing keys', () => {
  const cost = estimateTokenCost(
    { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 },
    {
      provider: 'OpenAI',
      model: 'gpt-test',
      pricing: {
        default: { inputUsdPerMillionTokens: 0, outputUsdPerMillionTokens: 0 },
        'gpt-test': { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 1 },
        'openai:gpt-test': { inputUsdPerMillionTokens: 2, outputUsdPerMillionTokens: 4 },
      },
    },
  );

  assert.equal(cost.provider, 'openai');
  assert.equal(cost.model, 'gpt-test');
  assert.equal(cost.total, 6);
});

test('breakdownDuration computes total, phase percentages, and unaccounted time', () => {
  const breakdown = breakdownDuration({
    startedAt: '2026-05-24T00:00:00.000Z',
    finishedAt: '2026-05-24T00:00:10.000Z',
    phases: [
      { key: 'model', label: 'Model', durationMs: 2500 },
      { key: 'tools', label: 'Tools', durationMs: 1500 },
    ],
  });

  assert.equal(breakdown.totalMs, 10_000);
  assert.equal(breakdown.unaccountedMs, 6_000);
  assert.deepEqual(breakdown.phases.map((p) => p.percent), [25, 15]);
});

test('buildUsageTransparency returns the backend display contract', () => {
  const summary = buildUsageTransparency({
    usages: [
      { prompt_tokens: 4, completion_tokens: 1 },
      { prompt_tokens: 6, completion_tokens: 9 },
    ],
    provider: 'openai/local',
    model: 'local-test',
    pricing: { 'local-test': { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 2 } },
    timing: { durationMs: 1234, phases: [{ key: 'model', label: 'Model', durationMs: 1000 }] },
  });

  assert.equal(summary.schemaVersion, 1);
  assert.equal(summary.provider, 'openai/local');
  assert.deepEqual(summary.tokens, { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 });
  assert.equal(summary.cost.total, 0.00003);
  assert.equal(summary.duration.unaccountedMs, 234);
  assert.equal(summary.disclosure.requiresSecret, false);
});
