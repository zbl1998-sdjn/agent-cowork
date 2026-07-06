import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveAgentContextOptions } from '../src/routes/agent-stream-context.js';
import { parseAgentStreamBody } from '../src/routes/agent-stream-schemas.js';

test('agent stream input schema rejects malformed images before streaming', () => {
  assert.throws(
    () => parseAgentStreamBody({ prompt: 'hello', images: ['image.png', 42] }),
    /agent stream body: images/,
  );
});

test('agent stream input schema keeps known route flags and unknown extension fields', () => {
  const body = parseAgentStreamBody({
    prompt: ' hello ',
    autoApprove: true,
    maxSteps: 3,
    thinking: 'deep',
    planMode: false,
    customExtension: { enabled: true },
  });

  assert.equal(body.prompt, ' hello ');
  assert.equal(body.autoApprove, true);
  assert.equal(body.maxSteps, 3);
  assert.equal(body.thinking, 'deep');
  assert.deepEqual(body.customExtension, { enabled: true });
});

test('agent stream input schema keeps context compaction controls', () => {
  const body = parseAgentStreamBody({
    prompt: 'long chat',
    contextCompaction: { enabled: true, maxContextTokens: '9000', keepRecentMessages: 8, maxFacts: '12' },
  });

  assert.deepEqual(body.contextCompaction, {
    enabled: true,
    maxContextTokens: '9000',
    keepRecentMessages: 8,
    maxFacts: '12',
  });
  assert.deepEqual(resolveAgentContextOptions(body), {
    maxContextTokens: 9000,
    keepRecentMessages: 8,
    maxFacts: 12,
  });
});

test('agent context options can disable automatic history compaction', () => {
  assert.deepEqual(resolveAgentContextOptions({ contextCompaction: { enabled: false } }), {
    maxContextTokens: 1_000_000_000,
  });
});

test('agent context options derive maxContextTokens from the selected model window', () => {
  // No explicit budget in the request → derive from the model's context window (0.75 headroom).
  assert.deepEqual(
    resolveAgentContextOptions({ prompt: 'hi' }, { provider: 'anthropic', model: 'claude-sonnet-5' }),
    { maxContextTokens: 150_000 },
  );
  assert.deepEqual(
    resolveAgentContextOptions({ prompt: 'hi' }, { provider: 'kimi-api', model: 'kimi-k2.7-code' }),
    { maxContextTokens: 96_000 },
  );
});

test('explicit maxContextTokens still wins over model-derived budget', () => {
  assert.deepEqual(
    resolveAgentContextOptions(
      { contextCompaction: { enabled: true, maxContextTokens: 9000 } },
      { provider: 'google', model: 'gemini-3.5-flash' },
    ),
    { maxContextTokens: 9000 },
  );
});

test('unknown model leaves maxContextTokens unset (compactor keeps its conservative default)', () => {
  assert.deepEqual(
    resolveAgentContextOptions({ prompt: 'hi' }, { provider: 'mystery', model: 'unknown-x' }),
    {},
  );
  // and calling without a model hint is unchanged (backward compatible)
  assert.deepEqual(resolveAgentContextOptions({ prompt: 'hi' }), {});
});