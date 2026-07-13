import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createServer } from '../src/server.js';
import {
  hasToolResult,
  noopKimiChatRunner,
  postAgentStream,
  readAgentStream,
  readKimiInfo,
  readRunRecord,
  startRunId,
  type AgentModelCallInput,
} from './helpers/agent-stream.js';
import { bind, close, tempRoot } from './helpers/host-http.js';
import { TEST_LOCAL_HOST_MODEL_CONFIG } from './helpers/kimi-config.js';

test('E2E /api/agent/chat/stream falls back through provider router without leaking secrets', async () => {
  const root = tempRoot('kcw-e2e-');
  const primarySecret = 'sk-test-primary-router-secret-1234567890'; // allowlist-secret
  const fallbackSecret = 'sk-test-fallback-router-secret-1234567890'; // allowlist-secret
  const seen: Array<{ baseUrl: string | undefined; apiKey: string | undefined }> = [];
  const agentModelCall = async ({ modelConfig, messages }: AgentModelCallInput) => {
    seen.push({ baseUrl: modelConfig?.baseUrl, apiKey: modelConfig?.apiKey });
    if (modelConfig?.baseUrl === 'http://127.0.0.1:11440/v1') {
      throw new Error(`temporary outage ${primarySecret}`);
    }
    if (hasToolResult(messages, 'fallback_write')) {
      return { content: 'fallback write done' };
    }
    return {
      content: '',
      tool_calls: [{
        id: 'fallback_write',
        function: { name: 'Write', arguments: JSON.stringify({ path: 'fallback.txt', content: modelConfig?.model }) },
      }],
    };
  };
  const server = createServer({
    requireAuth: false,
    trustedRoot: root,
    enableScheduler: false,
    securityMode: 'controlled_hybrid',
    kimiProvider: 'openai/local',
    kimiApiKey: primarySecret,
    kimiBaseUrl: 'http://127.0.0.1:11440/v1',
    kimiModel: 'gpt-primary-router',
    kimiFallbacks: [{
      provider: 'openai/local',
      apiKey: fallbackSecret,
      baseUrl: 'http://127.0.0.1:11441/v1',
      model: 'gpt-fallback-router',
    }],
    kimiChatRunner: noopKimiChatRunner,
    agentModelCall,
  });
  const base = await bind(server);
  try {
    const res = await postAgentStream(base, { prompt: 'fallback 写文件', autoApprove: true });
    assert.equal(res.status, 200);
    const all = await readAgentStream(res);
    assert.match(all, /event: model_fallback/);
    assert.match(all, /event: done/);
    assert.ok(!all.includes(primarySecret), 'SSE leaked primary key');
    assert.ok(!all.includes(fallbackSecret), 'SSE leaked fallback key');
    assert.deepEqual(seen.map((item) => item.baseUrl), [
      'http://127.0.0.1:11440/v1',
      'http://127.0.0.1:11441/v1',
      'http://127.0.0.1:11440/v1',
      'http://127.0.0.1:11441/v1',
    ]);
    assert.equal(seen[1]?.apiKey, fallbackSecret);
    assert.equal(seen[3]?.apiKey, fallbackSecret);
    assert.equal(fs.readFileSync(path.join(root, 'fallback.txt'), 'utf8'), 'gpt-fallback-router');
    const runId = startRunId(all);
    const recordRaw = fs.readFileSync(path.join(root, '.AgentCowork', 'runs', `${runId}.json`), 'utf8');
    assert.ok(!recordRaw.includes(primarySecret), 'run record leaked primary key');
    assert.ok(!recordRaw.includes(fallbackSecret), 'run record leaked fallback key');
    const record = readRunRecord(root, runId);
    assert.equal(record.configSnapshot.fallbacks?.[0]?.hasKey, true);
    assert.equal(record.configSnapshot.fallbacks?.[0]?.apiKey, undefined);
  } finally {
    await close(server);
  }
});

test('E2E /api/agent/chat/stream applies session model config without persisting or echoing keys', async () => {
  const root = tempRoot('kcw-e2e-');
  const sessionKey = 'test-session-secret-do-not-record';
  let capturedConfig: AgentModelCallInput['modelConfig'] | null = null;
  const requireCapturedConfig = (): NonNullable<AgentModelCallInput['modelConfig']> => {
    assert.ok(capturedConfig, 'agent model call should capture the session config');
    return capturedConfig;
  };
  const agentModelCall = async ({ modelConfig }: AgentModelCallInput) => {
    capturedConfig = modelConfig || null;
    return { content: 'session provider recorded' };
  };
  const server = createServer({
    ...TEST_LOCAL_HOST_MODEL_CONFIG,
    requireAuth: false,
    trustedRoot: root,
    enableScheduler: false,
    agentModelCall,
  });
  const base = await bind(server);
  try {
    const res = await postAgentStream(base, {
      prompt: '临时切 provider',
      modelConfig: {
        provider: 'OPENAI/LOCAL',
        apiKey: sessionKey,
        baseUrl: 'http://127.0.0.1:11442/v1/',
        model: 'gpt-session',
        fallbacks: [{ provider: 'openai/local', apiKey: 'test-body-fallback-secret' }],
      },
    });
    assert.equal(res.status, 200);
    const all = await readAgentStream(res);
    assert.match(all, /event: done/);
    const sessionConfig = requireCapturedConfig();
    assert.equal(sessionConfig.provider, 'openai/local');
    assert.equal(sessionConfig.model, 'gpt-session');
    assert.equal(sessionConfig.baseUrl, 'http://127.0.0.1:11442/v1');
    assert.equal(sessionConfig.apiKey, sessionKey);
    assert.ok(!JSON.stringify(sessionConfig.fallbacks || []).includes('test-body-fallback-secret'));

    const recordRaw = fs.readFileSync(path.join(root, '.AgentCowork', 'runs', `${startRunId(all)}.json`), 'utf8');
    const record = readRunRecord(root, startRunId(all));
    assert.equal(record.provider, 'openai/local');
    assert.equal(record.model, 'gpt-session');
    assert.equal(record.configSnapshot.provider, 'openai/local');
    assert.equal(record.configSnapshot.baseUrl, 'http://127.0.0.1:11442/v1');
    assert.equal(record.configSnapshot.apiKey, undefined);
    assert.ok(!recordRaw.includes(sessionKey), 'session API key leaked into run record');

    const info = await readKimiInfo(base);
    assert.ok(info.provider !== 'openai');
    assert.ok(info.model !== 'gpt-session');
    assert.ok(!info.raw.includes(sessionKey), 'session API key leaked into persisted config response');
    assert.ok(!info.raw.includes('test-body-fallback-secret'), 'request fallback key leaked into persisted config response');
  } finally {
    await close(server);
  }
});
