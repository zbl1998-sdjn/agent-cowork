import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { AddressInfo, Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createServer } from '../src/server.js';
import type { ChatMessage } from '../src/kimi/agent/tool-loop-types.js';
import type { KimiTextResult } from '../src/kimi/api-runner.js';
import type { ModelCall } from '../src/kimi/agent/model-resilience.js';
import { closeTestServer } from './helpers/close-server.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-vis-')); }

function kimiChatResult(): KimiTextResult {
  return {
    ok: true,
    provider: 'kimi-api',
    model: 'test-model',
    mode: 'chat',
    text: '',
    durationMs: 0,
  };
}

function messageArray(value: unknown): ChatMessage[] {
  assert.ok(Array.isArray(value), 'model call should receive messages');
  return value as ChatMessage[];
}

function contentParts(value: unknown): Record<string, unknown>[] {
  assert.ok(Array.isArray(value), 'user content should be multipart array');
  return value as Record<string, unknown>[];
}

async function bind(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object', 'test server should bind to a TCP port');
  return `http://127.0.0.1:${(address as AddressInfo).port}`;
}

test('E2E: agent stream attaches uploaded images as multipart image_url content', async () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]));
  let captured: ChatMessage[] = [];
  const agentModelCall: ModelCall = async (args) => { captured = messageArray(args.messages); return { content: '我看到一张图片。' }; };
  const server = createServer({ trustedRoot: root, enableScheduler: false, kimiChatRunner: async () => kimiChatResult(), agentModelCall });
  const base = await bind(server);
  try {
    const res = await fetch(`${base}/api/agent/chat/stream`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: '这是什么图', images: ['shot.png'] }) });
    assert.equal(res.status, 200);
    await res.text();
    const userMsg = captured.find((m) => m.role === 'user');
    assert.ok(userMsg, 'user message should be captured');
    assert.ok(Array.isArray(userMsg.content), 'user content is multipart array');
    const parts = contentParts(userMsg.content);
    assert.ok(parts.some((p) => {
      const imageUrl = p.image_url && typeof p.image_url === 'object' ? p.image_url as Record<string, unknown> : {};
      return p.type === 'image_url' && /^data:image\/png;base64,/.test(String(imageUrl.url || ''));
    }), 'has image_url part');
    assert.ok(parts.some((p) => p.type === 'text' && /这是什么图/.test(String(p.text || ''))), 'has text part');
    // 前缀缓存优化(caa53404)把 <env> 日期块从系统前缀挪到每轮用户消息最前面的独立 text part。
    assert.equal(parts[0]?.type, 'text', 'first part is the stable env preamble');
    assert.ok(/^<env>\n/.test(String(parts[0]?.text || '')), 'env preamble opens the multipart content');
  } finally {
    await closeTestServer(server);
  }
});

test('E2E: agent stream without images keeps a plain string user message', async () => {
  const root = tmp();
  let captured: ChatMessage[] = [];
  const agentModelCall: ModelCall = async (args) => { captured = messageArray(args.messages); return { content: 'ok' }; };
  const server = createServer({ trustedRoot: root, enableScheduler: false, kimiChatRunner: async () => kimiChatResult(), agentModelCall });
  const base = await bind(server);
  try {
    await (await fetch(`${base}/api/agent/chat/stream`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: '只是文字' }) })).text();
    const userMsg = captured.find((m) => m.role === 'user');
    assert.ok(userMsg, 'user message should be captured');
    assert.equal(typeof userMsg.content, 'string');
    // 前缀缓存优化(caa53404)把 <env> 日期块从系统前缀挪到每轮用户消息最前面,
    // 让 system+工具前缀跨天稳定可缓存;这里锁定"仍是纯字符串 + 原始 prompt 逐字保留在末尾"。
    const content = String(userMsg.content);
    assert.ok(content.startsWith('<env>\n'), 'user message is prefixed with the stable env preamble');
    assert.ok(content.includes('</env>'), 'env preamble is closed');
    assert.ok(content.endsWith('\n\n只是文字'), 'original prompt text follows the env preamble unchanged');
  } finally {
    await closeTestServer(server);
  }
});
