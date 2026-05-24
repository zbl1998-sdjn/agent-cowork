import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultAgentModelCall } from '../src/kimi/agent-runner.js';
import { resolveModelProvider } from '../src/kimi/provider/index.js';
import { parseOpenAiCompatibleStream } from '../src/kimi/provider/kimi.js';

function streamReader(lines) {
  const encoder = new TextEncoder();
  const chunks = lines.map((line) => encoder.encode(line));
  let index = 0;
  return {
    async read() {
      if (index >= chunks.length) return { done: true };
      return { value: chunks[index++], done: false };
    },
  };
}

test('resolveModelProvider accepts an injected provider seam', async () => {
  const provider = {
    async chatCompletion() {
      return { content: 'custom-provider' };
    },
  };
  assert.equal(resolveModelProvider({ provider }), provider);
  const message = await defaultAgentModelCall({ kimiConfig: { provider }, messages: [], tools: [] });
  assert.equal(message.content, 'custom-provider');
});

test('parseOpenAiCompatibleStream accumulates content, reasoning, tools, and usage', async () => {
  const tokens = [];
  const reasoning = [];
  const message = await parseOpenAiCompatibleStream(streamReader([
    'data: {"choices":[{"delta":{"reasoning_content":"why","content":"hel","tool_calls":[{"index":0,"id":"call_1","function":{"name":"Read","arguments":"{\\"path\\""}}]}}]}\n',
    'data: {"choices":[{"delta":{"content":"lo","tool_calls":[{"index":0,"function":{"arguments":":\\"a.txt\\"}"}}]}}],"usage":{"total_tokens":7}}\n',
    'data: [DONE]\n',
  ]), {
    onContent: (delta) => tokens.push(delta),
    onReasoning: (delta) => reasoning.push(delta),
  });
  assert.equal(message.content, 'hello');
  assert.equal(message.reasoning_content, 'why');
  assert.deepEqual(tokens, ['hel', 'lo']);
  assert.deepEqual(reasoning, ['why']);
  assert.equal(message.tool_calls[0].function.name, 'Read');
  assert.equal(message.tool_calls[0].function.arguments, '{"path":"a.txt"}');
  assert.equal(message.usage.total_tokens, 7);
});
