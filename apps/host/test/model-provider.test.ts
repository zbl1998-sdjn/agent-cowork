import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultAgentModelCall } from '../src/kimi/agent-runner.js';
import { createAnthropicProvider } from '../src/kimi/provider/anthropic.js';
import { resolveModelProvider } from '../src/kimi/provider/index.js';
import { createKimiProvider, parseOpenAiCompatibleStream } from '../src/kimi/provider/kimi.js';
import { modelBreaker, modelBreakerStats, modelProvider } from '../src/runtime/model-breakers.js';

type StreamReader = { read(): Promise<{ value?: Uint8Array; done?: boolean }> };
type RequestBody = Record<string, unknown> & {
  messages?: Array<{ role?: unknown; content?: Array<{ text?: unknown }> }>;
  tools?: Array<{
    function?: { name?: unknown };
    name?: unknown;
    input_schema?: { type?: unknown };
  }>;
};
type CapturedRequest = {
  url?: string;
  headers?: Record<string, string>;
  body?: RequestBody;
  signal?: AbortSignal;
};
type ToolCall = { id?: unknown; function: { name?: unknown; arguments?: unknown } };
type ModelMessage = Record<string, unknown> & {
  usage?: Record<string, unknown>;
  tool_calls?: ToolCall[];
  partial_tool_calls?: ToolCall[];
  stream_error?: string;
};
type FetchInit = { headers: Record<string, string>; body: string; signal?: AbortSignal };

function assertCaptured(captured: CapturedRequest): asserts captured is {
  url: string;
  headers: Record<string, string>;
  body: RequestBody;
  signal?: AbortSignal;
} {
  assert.equal(typeof captured.url, 'string');
  assert.ok(captured.headers);
  assert.ok(captured.body);
}

function streamReader(lines: string[]): StreamReader {
  const encoder = new TextEncoder();
  const chunks = lines.map((line) => encoder.encode(line));
  let index = 0;
  return {
    async read() {
      if (index >= chunks.length) return { done: true };
      const value = chunks[index];
      index += 1;
      assert.ok(value);
      return { value, done: false };
    },
  };
}

function interruptedStreamReader(lines: string[], error = new Error('stream socket closed')): StreamReader {
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
  assert.equal((message as ModelMessage).content, 'custom-provider');
});

test('resolveModelProvider registers OpenAI-compatible providers', () => {
  assert.equal(resolveModelProvider({ provider: 'openai' }).id, 'openai');
  assert.equal(resolveModelProvider({ provider: 'OPENAI-COMPATIBLE' }).id, 'openai');
  assert.equal(resolveModelProvider({ provider: 'openai/local' }).id, 'openai/local');
  assert.equal(resolveModelProvider({ provider: 'local-openai' }).id, 'openai/local');
});

test('resolveModelProvider registers Anthropic aliases', () => {
  assert.equal(resolveModelProvider({ provider: 'anthropic' }).id, 'anthropic');
  assert.equal(resolveModelProvider({ provider: 'CLAUDE' }).id, 'anthropic');
});

test('model breakers are scoped by normalized provider, endpoint, and model', () => {
  const first = modelBreaker({ provider: ' OpenAI ', baseUrl: 'https://breaker-a.example.invalid/v1', model: 'm1' });
  const same = modelBreaker({ provider: 'openai', baseUrl: 'https://breaker-a.example.invalid/v1', model: 'm1' });
  const otherEndpoint = modelBreaker({ provider: 'openai', baseUrl: 'https://breaker-b.example.invalid/v1', model: 'm1' });
  const otherModel = modelBreaker({ provider: 'openai', baseUrl: 'https://breaker-a.example.invalid/v1', model: 'm2' });

  assert.equal(modelProvider({ provider: '   ' }), 'kimi-api');
  assert.equal(first, same);
  assert.ok(first !== otherEndpoint);
  assert.ok(first !== otherModel);

  first.onFailure();
  const stats = modelBreakerStats();
  assert.ok(stats.some((item) => item.name === 'model:openai|https://breaker-a.example.invalid/v1|m1' && item.failures === 1));
});

test('defaultAgentModelCall routes OpenAI-compatible provider through fake fetch', async () => {
  const captured: CapturedRequest = {};
  const fetchImpl = async (url: string, init: FetchInit) => {
    captured.url = url;
    captured.headers = init.headers;
    captured.body = JSON.parse(init.body) as RequestBody;
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
  }) as ModelMessage;

  assertCaptured(captured);
  assert.equal(captured.url, 'https://api.openai.test/v1/chat/completions');
  assert.equal(captured.headers.authorization, 'Bearer sk-test-secret');
  assert.equal(captured.body.model, 'gpt-test');
  assert.equal(captured.body.stream, true);
  assert.equal(captured.body.max_tokens, 123);
  assert.equal(captured.body.temperature, 0.2);
  assert.equal(captured.body.tools?.[0]?.function?.name, 'Read');
  assert.equal(message.content, 'openai');
  assert.equal(message.provider, 'openai');
  assert.equal(message.model, 'gpt-test');
  assert.equal(message.usage?.total_tokens, 5);
});

test('defaultAgentModelCall routes Anthropic provider through fake fetch', async () => {
  const tokens: string[] = [];
  const captured: CapturedRequest = {};
  const fetchImpl = async (url: string, init: FetchInit) => {
    captured.url = url;
    captured.headers = init.headers;
    captured.body = JSON.parse(init.body) as RequestBody;
    return {
      ok: true,
      status: 200,
      body: {
        getReader: () => streamReader([
          'data: {"type":"message_start","message":{"usage":{"input_tokens":3}}}\n',
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hel"}}\n',
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}\n',
          'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"Read","input":{}}}\n',
          'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\""}}\n',
          'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":":\\"a.txt\\"}"}}\n',
          'data: {"type":"message_delta","usage":{"output_tokens":5}}\n',
        ]),
      },
    };
  };

  const message = await defaultAgentModelCall({
    kimiConfig: {
      provider: 'anthropic',
      apiKey: 'sk-ant-test-secret',
      baseUrl: 'https://api.anthropic.test/v1/',
      model: 'claude-test',
      maxTokens: 456,
      temperature: 0.1,
    },
    messages: [
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hi' },
    ],
    tools: [{ type: 'function', function: { name: 'Read', description: 'read file', parameters: { type: 'object' } } }],
    fetchImpl,
    onContent: (delta) => tokens.push(delta),
  }) as ModelMessage;

  assertCaptured(captured);
  assert.equal(captured.url, 'https://api.anthropic.test/v1/messages');
  assert.equal(captured.headers['x-api-key'], 'sk-ant-test-secret');
  assert.equal(captured.headers['anthropic-version'], '2023-06-01');
  assert.equal(captured.headers.authorization, undefined);
  assert.equal(captured.body.model, 'claude-test');
  assert.equal(captured.body.stream, true);
  assert.equal(captured.body.max_tokens, 456);
  assert.equal(captured.body.temperature, 0.1);
  assert.equal(captured.body.system, 'be brief');
  assert.equal(captured.body.messages?.[0]?.role, 'user');
  assert.equal(captured.body.messages?.[0]?.content?.[0]?.text, 'hi');
  assert.equal(captured.body.tools?.[0]?.name, 'Read');
  assert.equal(captured.body.tools?.[0]?.input_schema?.type, 'object');
  assert.deepEqual(tokens, ['hel', 'lo']);
  assert.equal(message.content, 'hello');
  assert.equal(message.provider, 'anthropic');
  assert.equal(message.model, 'claude-test');
  assert.equal(message.usage?.prompt_tokens, 3);
  assert.equal(message.usage?.completion_tokens, 5);
  assert.equal(message.usage?.total_tokens, 8);
  assert.equal(message.tool_calls?.[0]?.id, 'toolu_1');
  assert.equal(message.tool_calls?.[0]?.function.name, 'Read');
  assert.equal(message.tool_calls?.[0]?.function.arguments, '{"path":"a.txt"}');
});

test('local OpenAI-compatible provider does not require or send an API key', async () => {
  const captured: CapturedRequest = {};
  const fetchImpl = async (url: string, init: FetchInit) => {
    captured.url = url;
    captured.headers = init.headers;
    captured.body = JSON.parse(init.body) as RequestBody;
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
  }) as ModelMessage;

  assertCaptured(captured);
  assert.equal(captured.url, 'http://127.0.0.1:11434/v1/chat/completions');
  assert.equal(captured.headers.authorization, undefined);
  assert.equal(captured.body.model, 'local-model');
  assert.equal(message.content, 'local ok');
  assert.equal(message.provider, 'openai/local');
  assert.equal(message.model, 'local-model');
  assert.equal(message.usage?.total_tokens, 3);
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

test('Anthropic provider fails closed without API key or model', async () => {
  await assert.rejects(
    () => defaultAgentModelCall({
      kimiConfig: { provider: 'anthropic', baseUrl: 'https://api.anthropic.test/v1', model: 'claude-test' },
      messages: [],
      tools: [],
      fetchImpl: async () => {
        throw new Error('must not call fetch');
      },
    }),
    /Anthropic\/Claude/,
  );
  await assert.rejects(
    () => defaultAgentModelCall({
      kimiConfig: { provider: 'claude', apiKey: 'sk-test-ant', baseUrl: 'https://api.anthropic.test/v1' },
      messages: [],
      tools: [],
      fetchImpl: async () => {
        throw new Error('must not call fetch');
      },
    }),
    /Anthropic\/Claude/,
  );
});

test('Kimi provider posts streaming request metadata and falls back to JSON response bodies', async () => {
  const provider = createKimiProvider();
  const captured: CapturedRequest = {};
  const abort = new AbortController();
  const fetchImpl = async (url: string, init: FetchInit) => {
    captured.url = url;
    captured.headers = init.headers;
    captured.body = JSON.parse(init.body) as RequestBody;
    if (init.signal) captured.signal = init.signal;
    return {
      ok: true,
      status: 200,
      body: null,
      async json() {
        return { choices: [{ message: { content: 'json kimi ok', usage: { total_tokens: 11 } } }] };
      },
    };
  };

  const message = await provider.chatCompletion({
    kimiConfig: {
      apiKey: 'sk-test-kimi-provider',
      baseUrl: 'https://api.moonshot.test/v1/',
      model: 'moonshot-test',
      maxTokens: 77,
      temperature: 0.3,
      userAgent: 'agent-cowork-test',
    },
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ type: 'function', function: { name: 'Read', parameters: { type: 'object' } } }],
    fetchImpl,
    signal: abort.signal,
  }) as ModelMessage;

  assertCaptured(captured);
  assert.equal(captured.url, 'https://api.moonshot.test/v1/chat/completions');
  assert.equal(captured.headers.authorization, 'Bearer sk-test-kimi-provider');
  assert.equal(captured.headers['user-agent'], 'agent-cowork-test');
  assert.equal(captured.headers.accept, 'text/event-stream');
  assert.equal(captured.signal, abort.signal);
  assert.equal(captured.body.model, 'moonshot-test');
  assert.equal(captured.body.stream, true);
  assert.deepEqual(captured.body.stream_options, { include_usage: true });
  assert.equal(captured.body.max_tokens, 77);
  assert.equal(captured.body.temperature, 0.3);
  assert.equal(captured.body.tools?.[0]?.function?.name, 'Read');
  assert.equal(message.content, 'json kimi ok');
  assert.equal(message.usage?.total_tokens, 11);
});

test('Kimi provider fails closed before or after fetch when configuration or HTTP status is bad', async () => {
  const provider = createKimiProvider();
  await assert.rejects(
    () => provider.chatCompletion({
      kimiConfig: { baseUrl: 'https://api.moonshot.test/v1', model: 'moonshot-test' },
      messages: [],
      tools: [],
      fetchImpl: async () => {
        throw new Error('must not call fetch without key');
      },
    }),
    /Kimi\/Moonshot API Key/,
  );
  await assert.rejects(
    () => provider.chatCompletion({
      kimiConfig: {
        apiKey: 'sk-test-kimi-provider',
        baseUrl: 'https://api.moonshot.test/v1',
        model: 'moonshot-test',
      },
      messages: [],
      tools: [],
      fetchImpl: async () => ({
        ok: false,
        status: 503,
        body: null,
        async json() { return {}; },
      }),
    }),
    /status 503/,
  );
});

test('Anthropic provider converts OpenAI-style messages/tools and falls back to JSON response bodies', async () => {
  const provider = createAnthropicProvider();
  const captured: CapturedRequest = {};
  const fetchImpl = async (url: string, init: FetchInit) => {
    captured.url = url;
    captured.headers = init.headers;
    captured.body = JSON.parse(init.body) as RequestBody;
    return {
      ok: true,
      status: 200,
      body: null,
      async json() {
        return {
          content: [
            { type: 'text', text: 'json anthropic ok' },
            { type: 'tool_use', id: 'toolu_json', name: 'Write', input: { path: 'b.txt' } },
          ],
          usage: { input_tokens: 10, output_tokens: 3 },
        };
      },
    };
  };

  const message = await provider.chatCompletion({
    kimiConfig: {
      apiKey: 'sk-ant-provider-test',
      model: 'claude-json-test',
      maxTokens: 88,
      userAgent: 'agent-cowork-test',
    },
    messages: [
      { role: 'system', content: [{ text: 'system one' }, { content: 'system two' }] },
      {
        role: 'assistant',
        content: [{ text: 'previous answer' }],
        tool_calls: [
          { id: 'call_read', function: { name: 'Read', arguments: '{"path":"a.txt"}' } },
          { id: 'call_bad', function: { name: 'BadArgs', arguments: 'not json' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_read', content: ['tool result body'] },
      { role: 'user', content: [{ content: 'next question' }] },
    ],
    tools: [
      { type: 'function', function: { name: '', parameters: { type: 'object' } } },
      { type: 'function', function: { name: 'Read', description: 'read file', parameters: { type: 'object' } } },
    ],
    fetchImpl,
  }) as ModelMessage;

  assertCaptured(captured);
  assert.equal(captured.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(captured.headers['x-api-key'], 'sk-ant-provider-test');
  assert.equal(captured.headers['user-agent'], 'agent-cowork-test');
  assert.equal(captured.body.model, 'claude-json-test');
  assert.equal(captured.body.max_tokens, 88);
  assert.equal(captured.body.system, 'system one\nsystem two');
  assert.equal(captured.body.messages?.[0]?.role, 'assistant');
  assert.deepEqual(captured.body.messages?.[0]?.content?.[0], { type: 'text', text: 'previous answer' });
  assert.deepEqual(captured.body.messages?.[0]?.content?.[1], { type: 'tool_use', id: 'call_read', name: 'Read', input: { path: 'a.txt' } });
  assert.deepEqual(captured.body.messages?.[0]?.content?.[2], { type: 'tool_use', id: 'call_bad', name: 'BadArgs', input: {} });
  assert.equal(captured.body.messages?.[1]?.role, 'user');
  assert.deepEqual(captured.body.messages?.[1]?.content?.[0], { type: 'tool_result', tool_use_id: 'call_read', content: 'tool result body' });
  assert.equal(captured.body.messages?.[2]?.content?.[0]?.text, 'next question');
  assert.equal(captured.body.tools?.length, 1);
  assert.equal(captured.body.tools?.[0]?.name, 'Read');
  assert.equal(message.content, 'json anthropic ok');
  assert.equal(message.provider, 'anthropic');
  assert.equal(message.model, 'claude-json-test');
  assert.equal(message.usage?.prompt_tokens, 10);
  assert.equal(message.usage?.completion_tokens, 3);
  assert.equal(message.tool_calls?.[0]?.function.arguments, '{"path":"b.txt"}');
});

test('parseOpenAiCompatibleStream accumulates content, reasoning, tools, and usage', async () => {
  const tokens: string[] = [];
  const reasoning: string[] = [];
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
  const parsed = message as ModelMessage;
  assert.equal(parsed.tool_calls?.[0]?.function.name, 'Read');
  assert.equal(parsed.tool_calls?.[0]?.function.arguments, '{"path":"a.txt"}');
  assert.equal(parsed.usage?.total_tokens, 7);
});

test('parseOpenAiCompatibleStream returns accumulated message when stream breaks mid-flight', async () => {
  const tokens: string[] = [];
  const reasoning: string[] = [];
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
  const parsed = message as ModelMessage;
  assert.equal(parsed.tool_calls?.[0]?.function.name, 'Read');
  assert.equal(parsed.tool_calls?.[0]?.function.arguments, '{"path":"a.txt"}');
  assert.equal(parsed.usage?.total_tokens, 7);
  assert.equal(message.stream_interrupted, true);
  assert.equal(message.finish_reason, 'stream_interrupted');
  assert.match(String(parsed.stream_error), /stream socket closed/);
});

test('parseOpenAiCompatibleStream does not promote interrupted partial tool calls to executable calls', async () => {
  const message = await parseOpenAiCompatibleStream(interruptedStreamReader([
    'data: {"choices":[{"delta":{"content":"need file","tool_calls":[{"index":0,"id":"call_1","function":{"name":"Read","arguments":"{\\"path\\""}}]}}]}\n',
  ]));

  assert.equal(message.content, 'need file');
  assert.equal(message.stream_interrupted, true);
  assert.equal(message.tool_calls, undefined);
  const parsed = message as ModelMessage;
  assert.equal(parsed.partial_tool_calls?.[0]?.function.name, 'Read');
  assert.equal(parsed.partial_tool_calls?.[0]?.function.arguments, '{"path"');
});
