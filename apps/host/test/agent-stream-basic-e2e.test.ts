import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createServer } from '../src/server.js';
import {
  noopKimiChatRunner,
  postAgentStream,
  readAgentStream,
  readRunRecord,
  startRunId,
} from './helpers/agent-stream.js';
import { bind, close, tempRoot } from './helpers/host-http.js';
import { TEST_LOCAL_HOST_MODEL_CONFIG } from './helpers/kimi-config.js';

test('E2E /api/agent/chat/stream: file_written + verify_start + done (deep thinking)', async () => {
  const root = tempRoot('kcw-e2e-');
  let n = 0;
  const agentModelCall = async () => {
    n += 1;
    if (n === 1) return { content: '', tool_calls: [{ id: 'c1', function: { name: 'Write', arguments: JSON.stringify({ path: 'report.md', content: '# 报告' }) } }] };
    if (n === 2) return { content: '初稿完成。' };
    if (n === 3) return { content: '', tool_calls: [{ id: 'c3', function: { name: 'Read', arguments: JSON.stringify({ path: 'report.md' }) } }] };
    return { content: '已核对，report.md 无误。' };
  };
  const server = createServer({ ...TEST_LOCAL_HOST_MODEL_CONFIG, requireAuth: false, trustedRoot: root, enableScheduler: false, modelChatRunner: noopKimiChatRunner, agentModelCall });
  const base = await bind(server);
  try {
    const res = await postAgentStream(base, { prompt: '写报告', autoApprove: true, thinking: 'deep' });
    assert.equal(res.status, 200);
    const all = await readAgentStream(res);
    assert.match(all, /event: file_written/);
    assert.match(all, /report\.md/);
    assert.match(all, /event: verify_start/);
    assert.match(all, /event: done/);
    assert.match(all, /已核对/);
    assert.equal(fs.readFileSync(path.join(root, 'report.md'), 'utf8'), '# 报告');
  } finally {
    await close(server);
  }
});

test('E2E /api/agent/chat/stream: inline chart fenced block streams through to the client', async () => {
  const root = tempRoot('kcw-e2e-');
  const chart = '```chart\n{"kind":"bar","data":{"labels":["A","B"],"datasets":[{"data":[1,2]}]}}\n```';
  const agentModelCall = async () => ({ content: `这是结果：\n${chart}` });
  const server = createServer({ ...TEST_LOCAL_HOST_MODEL_CONFIG, requireAuth: false, trustedRoot: root, enableScheduler: false, modelChatRunner: noopKimiChatRunner, agentModelCall });
  const base = await bind(server);
  try {
    const res = await postAgentStream(base, { prompt: '画个图' });
    const all = await readAgentStream(res);
    assert.match(all, /event: done/);
    assert.ok(all.includes('chart') && all.includes('bar'), 'chart spec streamed to client for inline rendering');
  } finally {
    await close(server);
  }
});

test('E2E /api/agent/chat/stream records configured model provider', async () => {
  const root = tempRoot('kcw-e2e-');
  const agentModelCall = async () => ({ content: 'provider recorded' });
  const server = createServer({
    requireAuth: false,
    trustedRoot: root,
    enableScheduler: false,
    securityMode: 'controlled_hybrid',
    modelProvider: 'openai/local',
    modelApiKey: 'test-key-provider',
    modelBaseUrl: 'http://127.0.0.1:11434/v1',
    model: 'gpt-test',
    modelChatRunner: noopKimiChatRunner,
    agentModelCall,
  });
  const base = await bind(server);
  try {
    const res = await postAgentStream(base, { prompt: '记录 provider' });
    assert.equal(res.status, 200);
    const all = await readAgentStream(res);
    assert.match(all, /event: done/);
    const record = readRunRecord(root, startRunId(all));
    assert.equal(record.provider, 'openai/local');
    assert.equal(record.model, 'gpt-test');
    assert.equal(record.configSnapshot.provider, 'openai/local');
    assert.equal(record.configSnapshot.apiKey, undefined);
  } finally {
    await close(server);
  }
});
