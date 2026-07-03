import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createServer } from '../src/server.js';
import { isMemoryActive, writeMemorySettings } from '../src/memory/memory-control.js';
import type { AgentModelCallInput } from './helpers/agent-stream.js';
import { noopKimiChatRunner, postAgentStream, readAgentStream } from './helpers/agent-stream.js';
import { bind, close, tempRoot } from './helpers/host-http.js';

// 记忆总闸的判定真值表:启用且未暂停未隐身才算活跃(读注入/写回写共用)。
test('isMemoryActive is true only when enabled and not paused and not incognito', () => {
  assert.equal(isMemoryActive({ enabled: true, paused: false, incognito: false }), true);
  assert.equal(isMemoryActive({ enabled: false, paused: false, incognito: false }), false);
  assert.equal(isMemoryActive({ enabled: true, paused: true, incognito: false }), false);
  assert.equal(isMemoryActive({ enabled: true, paused: false, incognito: true }), false);
});

// 种一条带独特标记的项目层记忆,捕获传给模型的 system prompt。
const MEMORY_MARKER = '钦定暗号紫罗兰7788';

function seedProjectMemory(root: string): void {
  const dir = path.join(root, '.AgentCowork');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'MEMORY.md'), `- ${MEMORY_MARKER} 是本项目的记忆标记`, 'utf8');
}

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

test('E2E agent run injects layered memory when memory is active (control)', async () => {
  const root = tempRoot('kcw-mem-active-');
  seedProjectMemory(root);
  const model = captureModelCall();
  const server = createServer({ requireAuth: false, trustedRoot: root, enableScheduler: false, kimiChatRunner: noopKimiChatRunner, agentModelCall: model.call });
  const base = await bind(server);
  try {
    const res = await postAgentStream(base, { prompt: '你好' });
    assert.equal(res.status, 200);
    assert.match(await readAgentStream(res), /event: done/);
    // 活跃(默认设置)时,项目层记忆标记应注入 system prompt。
    assert.ok(model.systemPrompt().includes(MEMORY_MARKER), 'active memory should be injected into the system prompt');
  } finally {
    await close(server);
  }
});

test('E2E agent run does NOT inject layered memory when memory is paused', async () => {
  const root = tempRoot('kcw-mem-paused-');
  seedProjectMemory(root);
  // 用户在 UI 里把记忆暂停:实时对话应既不注入记忆(也不回写)。
  writeMemorySettings(root, { paused: true });
  const model = captureModelCall();
  const server = createServer({ requireAuth: false, trustedRoot: root, enableScheduler: false, kimiChatRunner: noopKimiChatRunner, agentModelCall: model.call });
  const base = await bind(server);
  try {
    const res = await postAgentStream(base, { prompt: '你好' });
    assert.equal(res.status, 200);
    assert.match(await readAgentStream(res), /event: done/);
    // 暂停时,记忆标记不得出现在 system prompt(否则 UI 开关对实时对话形同虚设)。
    assert.ok(!model.systemPrompt().includes(MEMORY_MARKER), 'paused memory must not be injected into the system prompt');
  } finally {
    await close(server);
  }
});
