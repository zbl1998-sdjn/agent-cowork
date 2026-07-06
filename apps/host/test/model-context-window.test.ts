import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_INPUT_RATIO,
  deriveHistoryBudgetTokens,
  resolveHistoryBudgetTokens,
  resolveModelContextWindowTokens,
} from '../src/kimi/context/model-context-window.js';

test('resolves conservative context windows by provider id', () => {
  assert.equal(resolveModelContextWindowTokens({ provider: 'anthropic', model: 'claude-sonnet-5' }), 200_000);
  assert.equal(resolveModelContextWindowTokens({ provider: 'google', model: 'gemini-3.5-flash' }), 1_000_000);
  assert.equal(resolveModelContextWindowTokens({ provider: 'kimi-api', model: 'kimi-k2.7-code' }), 128_000);
  assert.equal(resolveModelContextWindowTokens({ provider: 'deepseek', model: 'deepseek-v4-pro' }), 65_536);
});

test('resolves by model family when provider is unknown (e.g. openrouter/local)', () => {
  assert.equal(resolveModelContextWindowTokens({ provider: 'openrouter', model: 'anthropic/claude-sonnet-5' }), 200_000);
  assert.equal(resolveModelContextWindowTokens({ provider: 'openai/local', model: 'gemini-3-flash' }), 1_000_000);
  assert.equal(resolveModelContextWindowTokens({ provider: '', model: 'kimi-k2.6' }), 128_000);
});

test('model family match takes precedence over a mismatched provider default', () => {
  // Provider says openai (128k) but the routed model is a Claude → the model family wins.
  assert.equal(resolveModelContextWindowTokens({ provider: 'openrouter', model: 'anthropic/claude-opus-4.8' }), 200_000);
});

test('returns undefined for genuinely unknown provider and model', () => {
  assert.equal(resolveModelContextWindowTokens({ provider: 'mystery', model: 'unknown-model-x' }), undefined);
  assert.equal(resolveModelContextWindowTokens({ provider: '', model: '' }), undefined);
});

test('derives an input budget that leaves headroom for output', () => {
  assert.equal(deriveHistoryBudgetTokens(200_000, { inputRatio: 0.75 }), 150_000);
  assert.equal(deriveHistoryBudgetTokens(128_000, { inputRatio: 0.75 }), 96_000);
  // default ratio applies when none supplied
  assert.equal(deriveHistoryBudgetTokens(1_000_000), Math.floor(1_000_000 * DEFAULT_INPUT_RATIO));
});

test('derived budget stays positive and clamps an out-of-range ratio', () => {
  assert.ok(deriveHistoryBudgetTokens(8_000, { inputRatio: 5 }) <= 8_000);
  assert.ok(deriveHistoryBudgetTokens(8_000, { inputRatio: 0 }) > 0);
  assert.ok(deriveHistoryBudgetTokens(0) > 0);
});

test('resolveHistoryBudgetTokens returns a derived budget for known models, undefined otherwise', () => {
  assert.equal(resolveHistoryBudgetTokens({ provider: 'anthropic', model: 'claude-sonnet-5', inputRatio: 0.75 }), 150_000);
  assert.equal(resolveHistoryBudgetTokens({ provider: 'mystery', model: 'unknown-model-x' }), undefined);
});
