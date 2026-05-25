import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolResultSummarizer, createToolResultSummarizer } from '../src/kimi/context/tool-result-summarizer.js';
import { HeuristicTokenEstimator } from '../src/kimi/context/token-estimator.js';

test('tool result summarizer leaves small results readable and unsummarized', () => {
  const estimator = new HeuristicTokenEstimator({ charsPerToken: 4 });
  const summarizer = createToolResultSummarizer({ estimator, maxTokens: 200 });
  const result = { ok: true, path: 'reports/summary.md', content: 'short result' };

  const output = summarizer.shrink(result);

  assert.equal(output.summarized, false);
  assert.equal(output.beforeTokens, output.afterTokens);
  assert.ok(output.afterTokens <= 200);
  assert.match(output.content, /reports\/summary\.md/);
  assert.match(output.content, /short result/);
  assert.deepEqual(output.sources, ['reports/summary.md']);
});

test('tool result summarizer shrinks large structured results while preserving key points and sources', () => {
  const estimator = new HeuristicTokenEstimator({ charsPerToken: 4 });
  const summarizer = new ToolResultSummarizer({ estimator, maxTokens: 180, maxSources: 8, maxKeyPoints: 10 });
  const matches = [];
  for (let i = 0; i < 80; i += 1) {
    matches.push({
      path: `src/module-${i}.js`,
      line: i + 1,
      text: i === 42
        ? 'IMPORTANT: validate OAuth callback state before storing token'
        : `noise row ${i} ${'alpha beta gamma '.repeat(8)}`,
    });
  }
  const result = {
    query: 'oauth',
    matches,
    summary: 'IMPORTANT: OAuth callback state validation is the relevant finding',
  };

  const output = summarizer.shrink(result);

  assert.equal(output.summarized, true);
  assert.ok(output.beforeTokens > 180);
  assert.ok(output.afterTokens <= 180, `${output.afterTokens} should fit 180`);
  assert.match(output.content, /tool result summarized/i);
  assert.match(output.content, /OAuth callback state validation|validate OAuth callback state/i);
  assert.match(output.content, /src\/module-42\.js/);
  assert.ok(output.sources.includes('src/module-42.js'));
  assert.ok(output.keyPoints.some((point) => /OAuth callback state/i.test(point)));
  assert.doesNotMatch(output.content, /module-79.*alpha beta gamma.*alpha beta gamma/s);
});

test('tool result summarizer handles huge text results without dropping source-like lines', () => {
  const estimator = new HeuristicTokenEstimator({ charsPerToken: 4 });
  const summarizer = new ToolResultSummarizer({ estimator, maxTokens: 120, maxSources: 5 });
  const text = [
    'file: docs/runbook.md',
    'IMPORTANT: production install smoke failed at splash screen',
    ...Array.from({ length: 200 }, (_, i) => `log line ${i} ${'x'.repeat(80)}`),
    'source: https://example.invalid/internal-ticket/123',
  ].join('\n');

  const output = summarizer.shrink(text);

  assert.equal(output.summarized, true);
  assert.ok(output.afterTokens <= 120, `${output.afterTokens} should fit 120`);
  assert.match(output.content, /docs\/runbook\.md/);
  assert.match(output.content, /production install smoke failed/i);
  assert.ok(output.sources.some((source) => source.includes('docs/runbook.md')));
});
