import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from '../src/server.js';
import { makeTestWorkspace } from './test-fixtures.js';

async function withServer(config, fn) {
  const server = createServer({ requireAuth: false, ...config });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await fn(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const SECRET = 'sk-config-test-DO-NOT-ECHO-123456';

test('POST /api/kimi/config stores key, never echoes it, and flips enabled flags', async () => {
  const trustedRoot = makeTestWorkspace('kcw-kimicfg');
  await withServer({ trustedRoot }, async (baseUrl) => {
    // Initially nothing configured.
    let info = await (await fetch(`${baseUrl}/api/kimi/info`)).json();
    assert.equal(info.configured, false);
    assert.equal(info.hasKey, false);
    assert.equal(info.chatEnabled, false);

    const res = await fetch(`${baseUrl}/api/kimi/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        apiKey: SECRET,
        baseUrl: 'https://api.moonshot.cn/v1/',
        model: 'kimi-k2-test',
      }),
    });
    assert.equal(res.status, 200);
    const raw = await res.text();
    // The plaintext key must NEVER appear in the HTTP response.
    assert.ok(!raw.includes(SECRET), 'config response leaked the API key');
    const body = JSON.parse(raw);
    assert.equal(body.hasKey, true);
    assert.equal(body.configured, true);
    assert.equal(body.chatEnabled, true);
    assert.equal(body.planEnabled, true);
    assert.equal(body.baseUrl, 'https://api.moonshot.cn/v1'); // trailing slash trimmed
    assert.equal(body.model, 'kimi-k2-test');
    assert.equal(body.apiKey, undefined);

    // /api/kimi/info reflects the change and still hides the key.
    const infoRaw = await (await fetch(`${baseUrl}/api/kimi/info`)).text();
    assert.ok(!infoRaw.includes(SECRET), 'info response leaked the API key');
    info = JSON.parse(infoRaw);
    assert.equal(info.hasKey, true);
    assert.equal(info.configured, true);
    assert.equal(info.chatEnabled, true);
    assert.equal(info.model, 'kimi-k2-test');
  });

  // Key is persisted to the gitignored config file.
  const cfgPath = path.join(trustedRoot, '.AgentCowork', 'config.json');
  assert.ok(fs.existsSync(cfgPath), 'config.json was not written');
  const persisted = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  assert.equal(persisted.kimiApi.apiKey, SECRET);
  assert.equal(persisted.kimiApi.model, 'kimi-k2-test');
});

test('persisted config is reloaded on a fresh server boot (survives restart)', async () => {
  const trustedRoot = makeTestWorkspace('kcw-kimicfg-reload');
  fs.mkdirSync(path.join(trustedRoot, '.AgentCowork'), { recursive: true });
  fs.writeFileSync(
    path.join(trustedRoot, '.AgentCowork', 'config.json'),
    JSON.stringify({ kimiApi: { apiKey: SECRET, baseUrl: 'https://x.example/v1', model: 'persisted-model' } }),
    'utf8',
  );
  await withServer({ trustedRoot }, async (baseUrl) => {
    const info = await (await fetch(`${baseUrl}/api/kimi/info`)).json();
    assert.equal(info.hasKey, true);
    assert.equal(info.configured, true);
    assert.equal(info.chatEnabled, true);
    assert.equal(info.model, 'persisted-model');
    assert.equal(info.baseUrl, 'https://x.example/v1');
  });
});

test('POST /api/kimi/config stores provider without echoing the key', async () => {
  const trustedRoot = makeTestWorkspace('kcw-kimicfg-provider');
  await withServer({ trustedRoot }, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/kimi/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'OPENAI',
        apiKey: SECRET,
        baseUrl: 'https://api.openai.test/v1/',
        model: 'gpt-test',
      }),
    });
    assert.equal(res.status, 200);
    const raw = await res.text();
    assert.ok(!raw.includes(SECRET), 'config response leaked the API key');
    const body = JSON.parse(raw);
    assert.equal(body.provider, 'openai');
    assert.equal(body.hasKey, true);
    assert.equal(body.baseUrl, 'https://api.openai.test/v1');
    assert.equal(body.model, 'gpt-test');
  });

  const cfgPath = path.join(trustedRoot, '.AgentCowork', 'config.json');
  const persisted = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  assert.equal(persisted.kimiApi.provider, 'openai');
  assert.equal(persisted.kimiApi.apiKey, SECRET);

  await withServer({ trustedRoot }, async (baseUrl) => {
    const info = await (await fetch(`${baseUrl}/api/kimi/info`)).json();
    assert.equal(info.provider, 'openai');
    assert.equal(info.hasKey, true);
    assert.equal(info.model, 'gpt-test');
  });
});

test('POST /api/kimi/config stores fallback providers without echoing fallback keys', async () => {
  const trustedRoot = makeTestWorkspace('kcw-kimicfg-fallbacks');
  const fallbackSecret = 'sk-fallback-secret-DO-NOT-ECHO-123456';
  await withServer({ trustedRoot }, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/kimi/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'openai',
        apiKey: SECRET,
        model: 'gpt-primary',
        fallbacks: [
          { provider: 'openai/local', baseUrl: 'http://127.0.0.1:11434/v1/', model: 'local-model' },
          { provider: 'openai', apiKey: fallbackSecret, baseUrl: 'https://fallback.example/v1', model: 'gpt-fallback' },
        ],
      }),
    });
    assert.equal(res.status, 200);
    const raw = await res.text();
    assert.ok(!raw.includes(SECRET), 'config response leaked the primary API key');
    assert.ok(!raw.includes(fallbackSecret), 'config response leaked the fallback API key');
    const body = JSON.parse(raw);
    assert.equal(body.fallbacks.length, 2);
    assert.equal(body.fallbacks[0].provider, 'openai/local');
    assert.equal(body.fallbacks[0].hasKey, false);
    assert.equal(body.fallbacks[1].provider, 'openai');
    assert.equal(body.fallbacks[1].hasKey, true);
    assert.equal(body.fallbacks[1].apiKey, undefined);
  });

  const cfgPath = path.join(trustedRoot, '.AgentCowork', 'config.json');
  const persisted = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  assert.equal(persisted.kimiApi.fallbacks[0].baseUrl, 'http://127.0.0.1:11434/v1');
  assert.equal(persisted.kimiApi.fallbacks[1].apiKey, fallbackSecret);

  await withServer({ trustedRoot }, async (baseUrl) => {
    const raw = await (await fetch(`${baseUrl}/api/kimi/info`)).text();
    assert.ok(!raw.includes(fallbackSecret), 'info response leaked the fallback API key');
    const info = JSON.parse(raw);
    assert.equal(info.fallbacks[1].hasKey, true);
    assert.equal(info.fallbacks[1].model, 'gpt-fallback');
  });
});

test('clearKey wipes the stored key and disables the API', async () => {
  const trustedRoot = makeTestWorkspace('kcw-kimicfg-clear');
  await withServer({ trustedRoot }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/kimi/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: SECRET }),
    });
    let info = await (await fetch(`${baseUrl}/api/kimi/info`)).json();
    assert.equal(info.hasKey, true);

    const res = await fetch(`${baseUrl}/api/kimi/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clearKey: true }),
    });
    const body = await res.json();
    assert.equal(body.hasKey, false);
    assert.equal(body.configured, false);
    assert.equal(body.chatEnabled, false);

    info = await (await fetch(`${baseUrl}/api/kimi/info`)).json();
    assert.equal(info.hasKey, false);
    assert.equal(info.configured, false);
  });
});

test('updating only baseUrl/model keeps the existing key intact', async () => {
  const trustedRoot = makeTestWorkspace('kcw-kimicfg-partial');
  await withServer({ trustedRoot }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/kimi/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: SECRET, model: 'm1' }),
    });
    // No apiKey field this time -> key must be preserved.
    const res = await fetch(`${baseUrl}/api/kimi/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm2', baseUrl: 'https://y.example/v1' }),
    });
    const body = await res.json();
    assert.equal(body.hasKey, true);
    assert.equal(body.model, 'm2');
    assert.equal(body.baseUrl, 'https://y.example/v1');
  });
});
