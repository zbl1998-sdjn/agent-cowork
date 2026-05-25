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

function interruptedStreamReader(lines, error = new Error('stream socket closed')) {
  const reader = streamReader(lines);
  return {
    async read() {
      const next = await reader.read();
      if (next.done) throw error;
      return next;
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

test('resolveModelProvider registers OpenAI-compatible providers', () => {
  assert.equal(resolveModelProvider({ provider: 'openai' }).id, 'openai');
  assert.equal(resolveModelProvider({ provider: 'OPENAI-COMPATIBLE' }).id, 'openai');
  assert.equal(resolveModelProvider({ provider: 'openai/local' }).id, 'openai/local');
  assert.equal(resolveModelProvider({ provider: 'local-openai' }).id, 'openai/local');
});

test('defaultAgentModelCall routes OpenAI-compatible provider through fake fetch', async () => {
  const captured = {};
  const fetchImpl = async (url, init) => {
    captured.url = url;
    captured.headers = init.headers;
    captured.body = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      body: {
        getReader: () => streamReader([
          'data: {"choices":[{"delta":{"content":"open"}}]}\n',
          'data: {"choices":[{"delta":{"content":"ai"}}],"usage":{"total_tokens":5}}\n',
          'data: [DONE]\n',
        ]),
      },
    };
  };

  const message = await defaultAgentModelCall({
    kimiConfig: {
      provider: 'openai',
      apiKey: 'sk-test-secret',
      baseUrl: 'https://api.openai.test/v1/',
      model: 'gpt-test',
      maxTokens: 123,
      temperature: 0.2,
    },
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ type: 'function', function: { name: 'Read', parameters: { type: 'object' } } }],
    fetchImpl,
  });

  assert.equal(captured.url, 'https://api.openai.test/v1/chat/completions');
  assert.equal(captured.headers.authorization, 'Bearer sk-test-secret');
  assert.equal(captured.body.model, 'gpt-test');
  assert.equal(captured.body.stream, true);
  assert.equal(captured.body.max_tokens, 123);
  assert.equal(captured.body.temperature, 0.2);
  assert.equal(captured.body.tools[0].function.name, 'Read');
  assert.equal(message.content, 'openai');
  assert.equal(message.provider, 'openai');
  assert.equal(message.model, 'gpt-test');
  assert.equal(message.usage.total_tokens, 5);
});

test('local OpenAI-compatible provider does not require or send an API key', async () => {
  const captured = {};
  const fetchImpl = async (url, init) => {
    captured.url = url;
    captured.headers = init.headers;
    captured.body = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      body: null,
      async json() {
        return { choices: [{ message: { content: 'local ok' } }], usage: { total_tokens: 3 } };
      },
    };
  };

  const message = await defaultAgentModelCall({
    kimiConfig: {
      provider: 'openai/local',
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'local-model',
    },
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    fetchImpl,
  });

  assert.equal(captured.url, 'http://127.0.0.1:11434/v1/chat/completions');
  assert.equal(captured.headers.authorization, undefined);
  assert.equal(captured.body.model, 'local-model');
  assert.equal(message.content, 'local ok');
  assert.equal(message.provider, 'openai/local');
  assert.equal(message.model, 'local-model');
  assert.equal(message.usage.total_tokens, 3);
});

test('OpenAI provider fails closed without an API key', async () => {
  await assert.rejects(
    () => defaultAgentModelCall({
      kimiConfig: { provider: 'openai', baseUrl: 'https://api.openai.test/v1', model: 'gpt-test' },
      messages: [],
      tools: [],
      fetchImpl: async () => {
        throw new Error('must not call fetch');
      },
    }),
    /OpenAI API Key/,
  );
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

test('parseOpenAiCompatibleStream returns accumulated message when stream breaks mid-flight', async () => {
  const tokens = [];
  const reasoning = [];
  const message = await parseOpenAiCompatibleStream(interruptedStreamReader([
    'data: {"choices":[{"delta":{"reasoning_content":"why","content":"hel","tool_calls":[{"index":0,"id":"call_1","function":{"name":"Read","arguments":"{\\"path\\""}}]}}]}\n',
    'data: {"choices":[{"delta":{"content":"lo","tool_calls":[{"index":0,"function":{"arguments":":\\"a.txt\\"}"}}]}}],"usage":{"total_tokens":7}}\n',
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
  assert.equal(message.stream_interrupted, true);
  assert.equal(message.finish_reason, 'stream_interrupted');
  assert.match(message.stream_error, /stream socket closed/);
});

test('parseOpenAiCompatibleStream does not promote interrupted partial tool calls to executable calls', async () => {
  const message = await parseOpenAiCompatibleStream(interruptedStreamReader([
    'data: {"choices":[{"delta":{"content":"need file","tool_calls":[{"index":0,"id":"call_1","function":{"name":"Read","arguments":"{\\"path\\""}}]}}]}\n',
  ]));

  assert.equal(message.content, 'need file');
  assert.equal(message.stream_interrupted, true);
  assert.equal(message.tool_calls, undefined);
  assert.equal(message.partial_tool_calls[0].function.name, 'Read');
  assert.equal(message.partial_tool_calls[0].function.arguments, '{"path"');
});
