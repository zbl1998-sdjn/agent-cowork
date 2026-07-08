import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from '../src/server.js';
import { writeMemorySettings } from '../src/memory/memory-control.js';
import type { AgentModelCallInput } from './helpers/agent-stream.js';
import { noopKimiChatRunner, postAgentStream, readAgentStream } from './helpers/agent-stream.js';
import { bind, close, tempRoot } from './helpers/host-http.js';

// 回归:dogfood 2026-07-09 发现,关闭 MASE 时同会话多轮零对话记忆(Turn2 记不得 Turn1),
// 因为 host 不加载对话历史、多轮记忆 100% 依赖 MASE。自带对话缓冲修好这条:每轮成功写入缓冲,
// 下一轮把「本会话最近若干轮」注入 session 层。测试环境无 MASE,正好验证自带路径。

// 逐次记录每次模型调用收到的 system prompt(用于检查某一轮注入了什么)。
function captureModelCall(): { call: (input: AgentModelCallInput) => Promise<{ content: string }>; systemPromptAt: (i: number) => string; count: () => number } {
  const captured: string[] = [];
  return {
    call: async (input: AgentModelCallInput) => {
      const system = (input.messages || []).find((m) => m.role === 'system') as { content?: unknown } | undefined;
      captured.push(String(system?.content ?? ''));
      return { content: '好的，已记下。' };
    },
    systemPromptAt: (i: number) => captured[i] ?? '',
    count: () => captured.length,
  };
}

test('MASE off: same-conversation turn 2 recalls turn 1 via the built-in conversation buffer', async () => {
  const root = tempRoot('kcw-convmem-');
  const model = captureModelCall();
  const server = createServer({ requireAuth: false, trustedRoot: root, enableScheduler: false, kimiChatRunner: noopKimiChatRunner, agentModelCall: model.call });
  const base = await bind(server);
  try {
    const t1 = await postAgentStream(base, { prompt: '我的工位号是 555，请记住。', conversationId: 'conv-X' });
    assert.equal(t1.status, 200);
    assert.match(await readAgentStream(t1), /event: done/);

    const t2 = await postAgentStream(base, { prompt: '我的工位号是多少？', conversationId: 'conv-X' });
    assert.equal(t2.status, 200);
    assert.match(await readAgentStream(t2), /event: done/);

    // 关键:第二轮的 system prompt 必须带上第一轮说的 555(来自本地对话缓冲的 session 层注入)。
    const turn2System = model.systemPromptAt(1);
    assert.ok(turn2System.includes('555'), 'turn 2 system prompt should recall turn 1 content (555) from the built-in buffer');
    assert.match(turn2System, /本会话最近对话/);
  } finally {
    await close(server);
  }
});

test('conversation buffers are isolated: a different conversationId does not leak turn 1', async () => {
  const root = tempRoot('kcw-convmem-iso-');
  const model = captureModelCall();
  const server = createServer({ requireAuth: false, trustedRoot: root, enableScheduler: false, kimiChatRunner: noopKimiChatRunner, agentModelCall: model.call });
  const base = await bind(server);
  try {
    await readAgentStream(await postAgentStream(base, { prompt: '我的暗号是 蓝鲸4242。', conversationId: 'conv-A' }));
    await readAgentStream(await postAgentStream(base, { prompt: '暗号是多少？', conversationId: 'conv-B' }));
    // conv-B 的第二次调用(index 1)不该看到 conv-A 的暗号。
    assert.equal(model.systemPromptAt(1).includes('蓝鲸4242'), false, 'a different conversation must not see another conversation buffer');
  } finally {
    await close(server);
  }
});

test('paused memory does not buffer or inject prior turns', async () => {
  const root = tempRoot('kcw-convmem-paused-');
  writeMemorySettings(root, { paused: true });
  const model = captureModelCall();
  const server = createServer({ requireAuth: false, trustedRoot: root, enableScheduler: false, kimiChatRunner: noopKimiChatRunner, agentModelCall: model.call });
  const base = await bind(server);
  try {
    await readAgentStream(await postAgentStream(base, { prompt: '我的工位号是 555。', conversationId: 'conv-P' }));
    await readAgentStream(await postAgentStream(base, { prompt: '工位号？', conversationId: 'conv-P' }));
    // 暂停时既不缓冲也不注入:第二轮 system prompt 不该出现 555。
    assert.equal(model.systemPromptAt(1).includes('555'), false, 'paused memory must not buffer/inject prior turns');
  } finally {
    await close(server);
  }
});
