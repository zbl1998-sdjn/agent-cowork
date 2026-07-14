import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from '../src/server.js';
import { upsertKnowledgeItem } from '../src/memory/knowledge-store.js';
import { writeMemorySettings } from '../src/memory/memory-control.js';
import type { AgentModelCallInput } from './helpers/agent-stream.js';
import { noopKimiChatRunner, postAgentStream, readAgentStream } from './helpers/agent-stream.js';
import { bind, close, tempRoot } from './helpers/host-http.js';
import { TEST_LOCAL_HOST_MODEL_CONFIG } from './helpers/kimi-config.js';
const owner = { tenantId: 'tenant_local', userId: 'user_local' };

// 端到端:知识库里已有过往对话提炼出的主题知识,新对话按相关性把它召回进系统提示——
// 这是「关掉 MASE 也能在新对话里想起之前说的」的读侧闭环(写侧由 consolidate/trigger 覆盖)。
function captureModelCall(): { call: (input: AgentModelCallInput) => Promise<{ content: string }>; systemPrompt: () => string } {
  let captured = '';
  return {
    call: async (input: AgentModelCallInput) => {
      const system = (input.messages || []).find((m) => m.role === 'system') as { content?: unknown } | undefined;
      captured += String(system?.content ?? '');
      return { content: '好的' };
    },
    systemPrompt: () => captured,
  };
}

test('a new conversation recalls relevant active topic knowledge into the system prompt', async () => {
  const root = tempRoot('kcw-krecall-');
  upsertKnowledgeItem(root, { topic: '项目', title: '项目代号', content: '项目代号是 Phoenix-7', confidence: 0.95 }, { confidenceThreshold: 0.7, context: owner });
  const model = captureModelCall();
  const server = createServer({ ...TEST_LOCAL_HOST_MODEL_CONFIG, requireAuth: false, trustedRoot: root, enableScheduler: false, modelChatRunner: noopKimiChatRunner, agentModelCall: model.call });
  const base = await bind(server);
  try {
    const res = await postAgentStream(base, { prompt: '我们项目代号是什么来着？', conversationId: 'fresh-conv' });
    assert.equal(res.status, 200);
    assert.match(await readAgentStream(res), /event: done/);
    // 相关的过往主题知识被召回注入系统提示。
    assert.ok(model.systemPrompt().includes('Phoenix-7'), 'relevant topic knowledge should be recalled into the system prompt');
    assert.match(model.systemPrompt(), /长期记忆|记忆|知识/);
  } finally {
    await close(server);
  }
});

test('an unrelated prompt does not pull in topic knowledge (relevance-gated, no pollution)', async () => {
  const root = tempRoot('kcw-krecall-none-');
  upsertKnowledgeItem(root, { topic: '项目', title: '项目代号', content: '项目代号是 Phoenix-7', confidence: 0.95 }, { confidenceThreshold: 0.7, context: owner });
  const model = captureModelCall();
  const server = createServer({ ...TEST_LOCAL_HOST_MODEL_CONFIG, requireAuth: false, trustedRoot: root, enableScheduler: false, modelChatRunner: noopKimiChatRunner, agentModelCall: model.call });
  const base = await bind(server);
  try {
    await readAgentStream(await postAgentStream(base, { prompt: '帮我把这两个数相加：18 加 24', conversationId: 'fresh-conv-2' }));
    assert.equal(model.systemPrompt().includes('Phoenix-7'), false, 'unrelated prompt must not inject topic knowledge');
  } finally {
    await close(server);
  }
});

test('paused memory does not recall topic knowledge', async () => {
  const root = tempRoot('kcw-krecall-paused-');
  upsertKnowledgeItem(root, { topic: '项目', title: '项目代号', content: '项目代号是 Phoenix-7', confidence: 0.95 }, { confidenceThreshold: 0.7, context: owner });
  writeMemorySettings(root, { paused: true }, owner);
  const model = captureModelCall();
  const server = createServer({ ...TEST_LOCAL_HOST_MODEL_CONFIG, requireAuth: false, trustedRoot: root, enableScheduler: false, modelChatRunner: noopKimiChatRunner, agentModelCall: model.call });
  const base = await bind(server);
  try {
    await readAgentStream(await postAgentStream(base, { prompt: '项目代号是什么？', conversationId: 'fresh-conv-3' }));
    assert.equal(model.systemPrompt().includes('Phoenix-7'), false, 'paused memory must not recall knowledge');
  } finally {
    await close(server);
  }
});
