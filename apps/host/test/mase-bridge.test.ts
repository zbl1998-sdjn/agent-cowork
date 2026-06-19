import assert from 'node:assert/strict';
import test from 'node:test';
import { extractFactsFromUser, maseRecallSessionMemory, maseRememberTurn } from '../src/memory/mase-bridge.js';

type Call = { name: string; args: unknown };

// 最小 MCP 风格工具注册表 mock:按工具名返回 { content: [{ type:'text', text }] }。
function makeRegistry(handlers: Record<string, (args: unknown) => unknown>) {
  const calls: Call[] = [];
  return {
    calls,
    has: (name: string) => name in handlers,
    call: (name: string, args?: unknown) => {
      calls.push({ name, args });
      const handler = handlers[name];
      return handler ? handler(args) : { content: [] };
    },
  };
}

function mcpJson(value: unknown) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

// mase_recall 每条命中是独立的 text item({content:"…"});mock 与真实形状一致。
function mcpHits(hits: string[]) {
  return { content: hits.map((content) => ({ type: 'text', text: JSON.stringify({ content }) })) };
}

const TIMELINE = 'mcp__mase-memory__mase_recall_thread_tail';
const FACTS = 'mcp__mase-memory__mase_get_facts';
const RECALL = 'mcp__mase-memory__mase_recall';
const REMEMBER = 'mcp__mase-memory__mase_remember';
const UPSERT_FACT = 'mcp__mase-memory__mase_upsert_fact';

function recordValue(value: unknown, label: string): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} should be an object`);
  return value as Record<string, unknown>;
}

function callArgs(call: Call | undefined, label: string): Record<string, unknown> {
  assert.ok(call, `${label} should be called`);
  return recordValue(call.args, label);
}

test('recall labels 相关历史 as cross-conversation and dedups timeline turns', async () => {
  const registry = makeRegistry({
    [TIMELINE]: () => mcpJson([
      { role: 'user', content: '记住暗号青柠峡谷', timestamp: '2026-01-01T00:00:01Z' },
      { role: 'assistant', content: '已记住暗号青柠峡谷', timestamp: '2026-01-01T00:00:02Z' },
    ]),
    [FACTS]: () => mcpJson([]),
    // BM25 命中:一条是别的会话的问候(噪声),一条与本会话时间线重复。
    [RECALL]: () => mcpHits([
      '你好请用一句话告诉我你能在我电脑上帮我做什么',
      '记住暗号青柠峡谷',
    ]),
  });

  const out = await maseRecallSessionMemory(registry, '此窗口我说的第一句话是什么', 'cowork:t:u:conv-A');

  // ① 本会话时间线在场,且作为"第一句/刚才/本窗口"问题的依据。
  assert.match(out, /【最近对话】/);
  assert.match(out, /记住暗号青柠峡谷/);
  // ② 相关历史块必须标注「可能来自其它/历史会话、非本窗口」,避免模型把跨会话内容当成本窗口内容。
  assert.match(out, /【相关历史】/);
  assert.match(out, /其它|其他|历史会话|跨会话|别的对话/);
  assert.match(out, /不[是代]表?本(?:次|窗口|会话)|非本(?:次|窗口|会话)/);
  // ③ 与时间线重复的命中不应再出现在【相关历史】里(去重);跨会话噪声仍可在场(已标注来源)。
  const historyBlock = out.slice(out.indexOf('【相关历史】'));
  assert.doesNotMatch(historyBlock, /记住暗号青柠峡谷/);
  assert.match(historyBlock, /你好请用一句话/);
});

test('recall returns empty string when no MASE tools are registered (no-op)', async () => {
  const registry = makeRegistry({});
  const out = await maseRecallSessionMemory(registry, '随便问点啥', 'cowork:t:u:conv-A');
  assert.equal(out, '');
  assert.equal(await maseRecallSessionMemory(null, '随便问点啥', 'cowork:t:u:conv-A'), '');
});

test('recall injects sorted timeline, current facts, segmented query hits, and ignores malformed MCP text', async () => {
  let recallArgs: unknown = null;
  const longAssistant = `${'a'.repeat(210)} tail`;
  const registry = makeRegistry({
    [TIMELINE]: () => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify([
            { role: 'assistant', content: longAssistant, id: 3 },
            { role: 'user', content: '先说中文事实', id: 1 },
            { role: 'user', content: '   ', id: 2 },
            'malformed row',
          ]),
        },
        { type: 'text', text: 'not-json' },
      ],
    }),
    [FACTS]: () => ({
      content: [
        { type: 'text', text: JSON.stringify([{ entity_key: '默认模型', entity_value: 'Fable 5' }, { key: '城市', value: '悉尼' }]) },
        { type: 'text', text: JSON.stringify({ entity_key: '空值', entity_value: null }) },
        { type: 'text', text: 'not-json' },
      ],
    }),
    [RECALL]: (args) => {
      recallArgs = args;
      return {
        content: [
          { type: 'text', text: JSON.stringify({ content: '历史命中 A' }) },
          { type: 'text', text: 'raw history B' },
          { type: 'text', text: JSON.stringify({ content: '  ' }) },
        ],
      };
    },
  });

  const out = await maseRecallSessionMemory(registry, '中文ABC测试', 'thread-1', 3);

  assert.match(out, /【最近对话】/);
  assert.ok(out.indexOf('用户: 先说中文事实') < out.indexOf('助手: aaaaaaaaaa'), 'timeline should be sorted by fallback id');
  assert.match(out, /aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa…/);
  assert.match(out, /【当前事实】/);
  assert.match(out, /- 默认模型: Fable 5/);
  assert.match(out, /- 城市: 悉尼/);
  assert.doesNotMatch(out, /空值/);
  assert.match(out, /【相关历史】/);
  assert.match(out, /历史命中 A/);
  assert.match(out, /raw history B/);
  assert.deepEqual(recallArgs, { query: '中文 ABC 测试', top_k: 3 });
});

test('extractFactsFromUser keeps explicit user facts and filters questions, tasks, duplicates, and bad keys', () => {
  assert.deepEqual(extractFactsFromUser([
    '我的默认模型是 Fable 5',
    '还有我的发布分支改成 release/v1',
    '我的默认模型是 Fable 5',
    '今天天气是晴天',
    '默认模型是什么？',
    '301是房间号',
  ].join('。')), [
    { category: 'conversation_facts', key: '默认模型', value: 'Fable 5' },
    { category: 'conversation_facts', key: '发布分支', value: 'release/v1' },
  ]);

  assert.deepEqual(extractFactsFromUser('请记住一个事实: 项目代号是 MASE；更正一下: 默认模型改成 Fable 6'), [
    { category: 'conversation_facts', key: '项目代号', value: 'MASE' },
    { category: 'conversation_facts', key: '默认模型', value: 'Fable 6' },
  ]);
});

test('remember writes role-specific logs and upserts sourced facts without leaking oversized text', async () => {
  const registry = makeRegistry({
    [REMEMBER]: (args) => {
      const role = recordValue(args, 'remember args').role;
      return { content: [{ type: 'text', text: role === 'user' ? 'Event logged with ID 42' : 'assistant logged' }] };
    },
    [UPSERT_FACT]: () => ({ content: [] }),
  });
  const userText = `我的默认模型是 Fable 5。\n${'x'.repeat(5000)}`;

  await maseRememberTurn(registry, userText, '已记录', 'thread-2');

  assert.equal(registry.calls.length, 3);
  const userLog = callArgs(registry.calls[0], 'user remember');
  assert.equal(userLog.role, 'user');
  assert.equal(userLog.thread_id, 'thread-2');
  assert.equal(String(userLog.text).length, 4000);
  const assistantLog = callArgs(registry.calls[1], 'assistant remember');
  assert.equal(assistantLog.role, 'assistant');
  assert.equal(assistantLog.text, '已记录');

  const upsert = callArgs(registry.calls[2], 'fact upsert');
  assert.equal(upsert.category, 'conversation_facts');
  assert.equal(upsert.key, '默认模型');
  assert.equal(upsert.value, 'Fable 5');
  assert.equal(upsert.reason, 'agent-cowork:用户陈述');
  assert.equal(upsert.source_log_id, 42);
});

test('remember remains fail-safe when logging or individual fact upserts fail', async () => {
  const registry = makeRegistry({
    [REMEMBER]: () => {
      throw new Error('remember unavailable');
    },
    [UPSERT_FACT]: (args) => {
      if (recordValue(args, 'upsert args').key === '默认模型') {
        throw new Error('one fact failed');
      }
      return { content: [] };
    },
  });

  await maseRememberTurn(registry, '更正一下: 默认模型改成 Fable 6；项目代号是 Agent Cowork', '收到');

  const upsertCalls = registry.calls.filter((call) => call.name === UPSERT_FACT);
  assert.equal(upsertCalls.length, 2);
  assert.equal(callArgs(upsertCalls[0], 'first upsert').source_log_id, 0);
  assert.equal(callArgs(upsertCalls[0], 'first upsert').reason, 'agent-cowork:用户更正');
  assert.equal(callArgs(upsertCalls[1], 'second upsert').key, '项目代号');
});

test('remember is no-op for empty turns and missing tools', async () => {
  const registry = makeRegistry({});
  await maseRememberTurn(registry, '   ', '\n');
  await maseRememberTurn(registry, '我的默认模型是 Fable 5', '已记录');
  assert.equal(registry.calls.length, 0);
});
