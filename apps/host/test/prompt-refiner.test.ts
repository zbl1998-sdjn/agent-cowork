import test from 'node:test';
import assert from 'node:assert/strict';
import { createKimiRefineModelCall } from '../src/engine/prompt/refine-model-call.js';
import { analyzePromptForRefine } from '../src/engine/prompt/refine-policy.js';
import { createPromptRefiner, refinePrompt } from '../src/engine/prompt/refiner.js';
import { makeTestWorkspace } from './test-fixtures.js';

const LOCAL_TRUSTED_ROOT = makeTestWorkspace('prompt-refiner');
const LOCAL_MODEL = {
  provider: 'openai/local',
  baseUrl: 'http://127.0.0.1:11434/v1',
  securityMode: 'local_strict',
} as const;

test('refine policy asks for clarification when the prompt is too vague', () => {
  const result = analyzePromptForRefine('帮我处理一下');
  assert.equal(result.needsClarification, true);
  assert.equal(result.shouldRefine, false);
  assert.deepEqual(result.missing, ['action', 'target', 'desiredOutput']);
});

// 足够明确的长提示:动作(审查/列出)+ 对象(server.js)+ 产出(表格清单)+ 篇幅 ≥ 阈值。
const EXPLICIT_PROMPT = '请审查 apps/host/src/server.js 的鉴权与会话校验逻辑,逐条列出所有高风险问题及其触发条件,并输出一份包含风险等级、影响范围与修复建议的表格清单。';

test('refine policy keeps explicit prompts refine-eligible (skip decided downstream)', () => {
  const result = analyzePromptForRefine(EXPLICIT_PROMPT);
  assert.equal(result.needsClarification, false);
  assert.equal(result.shouldRefine, true);
  assert.equal(result.explicit, true);
  assert.deepEqual(result.missing, []);
});

test('prompt refiner leaves an already-explicit prompt unchanged when no model is available', async () => {
  const result = await refinePrompt(EXPLICIT_PROMPT, {}, {});
  assert.equal(result.changed, false);
  assert.equal(result.refined, EXPLICIT_PROMPT);
});

test('prompt refiner uses model output when injected', async () => {
  const refiner = createPromptRefiner({
    modelCall: async ({ prompt, intent }) => `请分析 ${prompt}，任务类型=${intent}，并输出可执行步骤。`,
  });

  const result = await refiner.refine('分析当前项目测试覆盖薄弱点');

  assert.equal(result.changed, true);
  assert.equal(result.intent, 'review');
  assert.match(result.refined, /可执行步骤/);
  assert.deepEqual(result.missing, []);
});

test('prompt refiner accepts object model output and skips unchanged output', async () => {
  const objectResult = await refinePrompt('分析当前项目测试覆盖薄弱点', {}, {
    modelCall: async () => ({ content: '请分析当前项目测试覆盖薄弱点，并列出可执行修复步骤。' }),
  });
  assert.equal(objectResult.changed, true);
  assert.match(objectResult.refined, /可执行修复步骤/);

  const unchanged = await refinePrompt('分析当前项目测试覆盖薄弱点', {}, {
    modelCall: async ({ prompt }) => ({ text: prompt }),
  });
  assert.equal(unchanged.changed, false);
  assert.equal(unchanged.refined, '分析当前项目测试覆盖薄弱点');
});

test('prompt refiner falls back to original text when model refinement fails', async () => {
  const result = await refinePrompt('分析当前项目测试覆盖薄弱点', {}, {
    modelCall: async () => {
      throw new Error('model unavailable');
    },
  });

  assert.equal(result.changed, false);
  assert.equal(result.refined, '分析当前项目测试覆盖薄弱点');
  assert.deepEqual(result.missing, []);
});

test('prompt refiner uses local fallback with project and profile context when no model is configured', async () => {
  const result = await refinePrompt('把登录那块的报错处理一下', {
    project: 'Agent Cowork',
    profile: { terms: ['鉴权', '', 'Windows 客户端'] },
  });

  assert.equal(result.changed, true);
  assert.equal(result.needsClarification, false);
  assert.match(result.refined, /原始需求/);
  assert.match(result.refined, /任务类型：修复/);
  assert.match(result.refined, /Agent Cowork、鉴权、Windows 客户端/);
});

test('refine policy covers common verbs/objects and long sentences', () => {
  // 动作/对象词表放宽:「处理 / 登录 / 报错」等常见说法现在能被识别为有意图。
  const recognized = analyzePromptForRefine('把登录那块的报错处理一下');
  assert.equal(recognized.needsClarification, false);
  assert.equal(recognized.shouldRefine, true);

  // 够长兜底:没命中任何词表,但句子够长 → 仍按带意图处理,交给改写器。
  const longish = analyzePromptForRefine('我那个东西最近老是怪怪的你帮我弄一弄看看能不能好');
  assert.equal(longish.needsClarification, false);
  assert.equal(longish.shouldRefine, true);

  // 仍然追问:又短、又没动作没对象。
  const stillVague = analyzePromptForRefine('这个');
  assert.equal(stillVague.needsClarification, true);
  assert.equal(stillVague.shouldRefine, false);
});

test('createKimiRefineModelCall posts a bounded non-streaming refinement request', async () => {
  const calls: Array<{ url: string; init: Record<string, unknown> }> = [];
  const fetchImpl = async (url: string, init: Record<string, unknown> = {}) => {
    calls.push({ url, init });
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '  请修复登录报错，并说明验证步骤。  ' } }],
      }),
    };
  };
  const modelCall = createKimiRefineModelCall({
    modelConfig: {
      ...LOCAL_MODEL,
      apiKey: 'dummy-refine-key',
      model: 'kimi-refine',
      maxTokens: 256,
      timeoutMs: 2000,
      temperature: 0.2,
    },
    fetchImpl: fetchImpl as never,
  });

  const refined = await modelCall({
    prompt: '处理登录报错',
    intent: 'fix',
    missing: ['desiredOutput'],
    context: { trustedRoot: LOCAL_TRUSTED_ROOT, project: 'Agent Cowork', profile: { terms: ['鉴权'] } },
  });

  assert.equal(refined, '请修复登录报错，并说明验证步骤。');
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.ok(call);
  assert.equal(call.url, 'http://127.0.0.1:11434/v1/chat/completions');
  assert.equal(call.init.method, 'POST');
  assert.deepEqual(call.init.headers, {
    authorization: 'Bearer dummy-refine-key',
    'content-type': 'application/json',
    accept: 'application/json',
  });
  assert.ok(call.init.signal, 'abort signal passed to fetch');
  const body = JSON.parse(String(call.init.body)) as {
    model: string;
    messages: Array<{ role: string; content: string }>;
    max_tokens: number;
    temperature?: number;
    stream: boolean;
  };
  assert.equal(body.model, 'kimi-refine');
  assert.equal(body.max_tokens, 256);
  assert.equal(body.temperature, 0.2);
  assert.equal(body.stream, false);
  assert.match(body.messages[0]?.content || '', /任务类型:修复/);
  assert.match(body.messages[0]?.content || '', /可补强的要素:desiredOutput/);
  assert.match(body.messages[0]?.content || '', /相关上下文:Agent Cowork、鉴权/);
  assert.equal(body.messages[1]?.content, '处理登录报错');
});

test('createKimiRefineModelCall fails closed on missing key, HTTP errors, and malformed responses', async () => {
  const noKey = createKimiRefineModelCall({ modelConfig: {}, fetchImpl: (async () => { throw new Error('should not fetch'); }) as never });
  assert.equal(await noKey({ prompt: 'x', intent: 'general', missing: [], context: {} }), '');

  const nonOk = createKimiRefineModelCall({
    modelConfig: { ...LOCAL_MODEL, apiKey: 'dummy-refine-key' },
    fetchImpl: (async () => ({ ok: false, json: async () => ({}) })) as never,
  });
  assert.equal(await nonOk({ prompt: 'x', intent: 'general', missing: [], context: { trustedRoot: LOCAL_TRUSTED_ROOT } }), '');

  const malformed = createKimiRefineModelCall({
    modelConfig: { ...LOCAL_MODEL, apiKey: 'dummy-refine-key' },
    fetchImpl: (async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 42 } }] }) })) as never,
  });
  assert.equal(await malformed({ prompt: 'x', intent: 'general', missing: [], context: { trustedRoot: LOCAL_TRUSTED_ROOT } }), '');

  const thrown = createKimiRefineModelCall({
    modelConfig: { ...LOCAL_MODEL, apiKey: 'dummy-refine-key' },
    fetchImpl: (async () => { throw new Error('network down'); }) as never,
  });
  assert.equal(await thrown({ prompt: 'x', intent: 'general', missing: [], context: { trustedRoot: LOCAL_TRUSTED_ROOT } }), '');
});
