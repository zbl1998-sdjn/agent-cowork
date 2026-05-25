import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createServer } from '../src/server.js';
import { SYSTEM_PROMPT_VERSION } from '../src/kimi/system-prompt.js';
import { buildRunAttribution } from '../src/runtime/run-attribution.js';
import { readRunRecord, writeRunRecord } from '../src/runtime/run-store.js';
import { closeTestServer } from './helpers/close-server.js';

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-run-attr-'));
}

async function bind(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

test('buildRunAttribution records prompt, model, and config versions without secrets', () => {
  const secret = 'sk-ATTRSECRET1234567890';
  const attribution = buildRunAttribution({
    type: 'agent-chat',
    provider: 'kimi-api',
    model: 'moonshot-v1-8k',
    mode: 'agent',
    systemPromptVersion: SYSTEM_PROMPT_VERSION,
    promptBuilder: 'agent-system-prompt',
    input: { prompt: '分析本地报告' },
    configSnapshot: {
      baseUrl: 'https://api.moonshot.cn/v1',
      apiKey: secret,
      maxTokens: 4096,
      temperature: 0.2,
      nested: { accessToken: 'token-should-not-leak' },
    },
  });

  assert.equal(attribution.schemaVersion, 1);
  assert.equal(attribution.prompt.systemPromptVersion, SYSTEM_PROMPT_VERSION);
  assert.equal(attribution.prompt.builder, 'agent-system-prompt');
  assert.equal(attribution.prompt.inputChars, 6);
  assert.match(attribution.prompt.inputSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(attribution.model, {
    provider: 'kimi-api',
    model: 'moonshot-v1-8k',
    mode: 'agent',
    baseUrl: 'https://api.moonshot.cn/v1',
  });
  assert.equal(attribution.config.apiKey, '[REDACTED]');
  assert.equal(attribution.config.nested.accessToken, '[REDACTED]');
  assert.equal(JSON.stringify(attribution).includes(secret), false);
});

test('writeRunRecord attaches attribution to every persisted run record', () => {
  const secret = 'sk-WRITEATTRSECRET1234567890';
  const runStoreRoot = path.join(tempRoot(), 'runs');
  writeRunRecord(runStoreRoot, {
    id: 'run_attr_persisted',
    type: 'kimi-chat',
    provider: 'kimi-api',
    model: 'kimi-k2-test',
    mode: 'chat',
    status: 'succeeded',
    startedAt: '2026-05-25T00:00:00.000Z',
    systemPromptVersion: SYSTEM_PROMPT_VERSION,
    promptBuilder: 'kimi-chat-prompt',
    input: { prompt: 'hello' },
    configSnapshot: { apiKey: secret, timeoutMs: 3000 },
    result: { ok: true, text: 'hi' },
  });

  const record = readRunRecord(runStoreRoot, 'run_attr_persisted');
  assert.equal(record.attribution.prompt.systemPromptVersion, SYSTEM_PROMPT_VERSION);
  assert.equal(record.attribution.model.model, 'kimi-k2-test');
  assert.equal(record.attribution.config.apiKey, '[REDACTED]');
  assert.equal(JSON.stringify(record.attribution).includes(secret), false);
});

test('agent stream persists system-prompt version and safe config attribution', async () => {
  const root = tempRoot();
  const agentModelCall = async () => ({ content: '完成。', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  const server = createServer({
    trustedRoot: root,
    enableScheduler: false,
    kimiApiKey: 'sk-SERVERATTRSECRET1234567890',
    kimiBaseUrl: 'https://api.example.test/v1',
    kimiModel: 'agent-attr-model',
    kimiApiTimeoutMs: 7000,
    kimiApiMaxTokens: 1234,
    kimiTemperature: 0.4,
    kimiChatRunner: async () => ({}),
    agentModelCall,
  });
  const base = await bind(server);

  try {
    const response = await fetch(`${base}/api/agent/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: '记录归因', developerMode: true, maxSteps: 3 }),
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /event: done/);

    const runStoreRoot = path.join(root, '.AgentCowork', 'runs');
    const records = fs
      .readdirSync(runStoreRoot)
      .filter((name) => name.endsWith('.json'))
      .map((name) => JSON.parse(fs.readFileSync(path.join(runStoreRoot, name), 'utf8')));
    const record = records.find((item) => item.type === 'agent-chat');
    assert.ok(record, 'agent-chat run record persisted');
    assert.equal(record.attribution.prompt.systemPromptVersion, SYSTEM_PROMPT_VERSION);
    assert.equal(record.attribution.prompt.builder, 'agent-system-prompt');
    assert.equal(record.attribution.model.model, 'agent-attr-model');
    assert.equal(record.attribution.config.maxTokens, 1234);
    assert.equal(record.attribution.config.developerMode, true);
    assert.equal(record.attribution.config.maxSteps, 3);
    assert.equal(JSON.stringify(record.attribution).includes('SERVERATTRSECRET'), false);
  } finally {
    await closeTestServer(server);
  }
});
