import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { AddressInfo, Server } from 'node:http';
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  assert.ok(isRecord(value), `${label} should be an object`);
  return value;
}

async function bind(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object', 'test server should bind to a TCP port');
  const { port } = address as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

test('buildRunAttribution records prompt, model, and config versions without secrets', () => {
  const secret = 'sk-test-attr-secret-1234567890';
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
  assert.ok(attribution.prompt.inputSha256);
  assert.match(attribution.prompt.inputSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(attribution.model, {
    provider: 'kimi-api',
    model: 'moonshot-v1-8k',
    mode: 'agent',
    baseUrl: 'https://api.moonshot.cn/v1',
  });
  assert.equal(attribution.config.apiKey, '[REDACTED]');
  const nestedConfig = expectRecord(attribution.config.nested, 'nested config');
  assert.equal(nestedConfig.accessToken, '[REDACTED]');
  assert.equal(JSON.stringify(attribution).includes(secret), false);
});

test('writeRunRecord attaches attribution to every persisted run record', () => {
  const secret = 'sk-test-write-attr-secret-1234567890';
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
  assert.ok(record, 'run record should be persisted');
  const attribution = expectRecord(record.attribution, 'run attribution');
  const prompt = expectRecord(attribution.prompt, 'run attribution prompt');
  const model = expectRecord(attribution.model, 'run attribution model');
  const config = expectRecord(attribution.config, 'run attribution config');
  assert.equal(prompt.systemPromptVersion, SYSTEM_PROMPT_VERSION);
  assert.equal(model.model, 'kimi-k2-test');
  assert.equal(config.apiKey, '[REDACTED]');
  assert.equal(JSON.stringify(attribution).includes(secret), false);
});

test('agent stream persists system-prompt version and safe config attribution', async () => {
  const root = tempRoot();
  const agentModelCall = async () => ({ content: '完成。', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  const server = createServer({
    trustedRoot: root,
    enableScheduler: false,
    kimiApiKey: 'sk-test-server-attr-secret-1234567890',
    kimiBaseUrl: 'https://api.example.test/v1',
    kimiModel: 'agent-attr-model',
    kimiApiTimeoutMs: 7000,
    kimiApiMaxTokens: 1234,
    kimiTemperature: 0.4,
    kimiChatRunner: async () => ({
      ok: true,
      provider: 'kimi-api',
      model: 'agent-attr-model',
      mode: 'chat',
      text: '',
      durationMs: 0,
    }),
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
      .map((name): unknown => JSON.parse(fs.readFileSync(path.join(runStoreRoot, name), 'utf8')));
    const record = records.find((item): item is Record<string, unknown> => isRecord(item) && item.type === 'agent-chat');
    assert.ok(record, 'agent-chat run record persisted');
    const attribution = expectRecord(record.attribution, 'agent run attribution');
    const prompt = expectRecord(attribution.prompt, 'agent run attribution prompt');
    const model = expectRecord(attribution.model, 'agent run attribution model');
    const config = expectRecord(attribution.config, 'agent run attribution config');
    assert.equal(prompt.systemPromptVersion, SYSTEM_PROMPT_VERSION);
    assert.equal(prompt.builder, 'agent-system-prompt');
    assert.equal(model.model, 'agent-attr-model');
    assert.equal(config.maxTokens, 1234);
    assert.equal(config.developerMode, true);
    assert.equal(config.maxSteps, 3);
    assert.equal(JSON.stringify(attribution).includes('sk-test-server-attr-secret'), false);
  } finally {
    await closeTestServer(server);
  }
});
