import assert from 'node:assert/strict';
import test from 'node:test';
import { maseRecallSessionMemory } from '../src/memory/mase-bridge.js';

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
});
