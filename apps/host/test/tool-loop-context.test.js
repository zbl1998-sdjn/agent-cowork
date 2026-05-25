import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAgentChat } from '../src/kimi/agent-runner.js';
import { createContextManager } from '../src/kimi/context/context-manager.js';
import { HeuristicTokenEstimator } from '../src/kimi/context/token-estimator.js';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-tool-loop-context-'));
}

test('runAgentChat summarizes oversized tool results before the next model turn', async () => {
  const root = tmp();
  const estimator = new HeuristicTokenEstimator({ charsPerToken: 4 });
  const contextManager = createContextManager({
    estimator,
    maxToolResultTokens: 170,
    maxContextTokens: 2_000,
  });
  const tools = [{
    name: 'Search',
    risk: 'safe',
    mutating: false,
    description: 'Searches a large result set',
    parameters: { type: 'object', properties: {} },
    handler: async () => ({
      summary: 'IMPORTANT: validate OAuth callback state before storing token',
      matches: Array.from({ length: 90 }, (_, i) => ({
        path: `src/module-${i}.js`,
        line: i + 1,
        text: i === 42
          ? 'IMPORTANT: validate OAuth callback state before storing token'
          : `noise row ${i} ${'alpha beta gamma '.repeat(10)}`,
      })),
    }),
  }];
  let calls = 0;
  let capturedToolMessage = null;
  const modelCall = async ({ messages }) => {
    calls += 1;
    if (calls === 1) {
      return { content: '', tool_calls: [{ id: 'call_search', function: { name: 'Search', arguments: '{}' } }] };
    }
    capturedToolMessage = messages.at(-1);
    return { content: 'done' };
  };

  const out = await runAgentChat({
    prompt: 'search',
    kimiConfig: { model: 'fake' },
    trustedRoot: root,
    tools,
    modelCall,
    contextManager,
    runStoreRoot: path.join(root, 'runs'),
  });

  assert.equal(out.text, 'done');
  assert.equal(capturedToolMessage?.role, 'tool');
  assert.ok(estimator.estimateText(capturedToolMessage.content) <= 170);
  assert.match(capturedToolMessage.content, /tool result summarized/i);
  assert.match(capturedToolMessage.content, /OAuth callback state/i);
  assert.match(capturedToolMessage.content, /src\/module-42\.js/);
  assert.doesNotMatch(capturedToolMessage.content, /module-89.*alpha beta gamma.*alpha beta gamma/s);
});
