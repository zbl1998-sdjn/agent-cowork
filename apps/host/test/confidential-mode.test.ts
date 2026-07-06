// 机密模式一键 profile(切片 1)——总开关 fail-closed 行为矩阵
// ---------------------------------------------------------------------------
// KCW_CONFIDENTIAL=1 必须:强制 air_gap(任何配置/env 不能削弱)→ 云模型拒绝、
// 外网工具拒绝、启动期 MCP(含 MASE)全部丢弃、OAuth 路由 403、selfcheck 可见。
import assert from 'node:assert/strict';
import test from 'node:test';
import { isConfidentialMode, filterMcpServersForConfidential } from '../src/security/confidential.js';
import { decideModelProviderPolicy, resolveSecurityMode } from '../src/security/security-mode.js';
import { decideToolPolicy } from '../src/security/policy-decision.js';
import { createServer } from '../src/server.js';
import { noopKimiChatRunner } from './helpers/agent-stream.js';
import { bind, close, jsonRequest, recordValue, tempRoot } from './helpers/host-http.js';

test('isConfidentialMode parses truthy switches and rejects everything else', () => {
  for (const value of ['1', 'true', 'on', 'yes', ' TRUE ']) {
    assert.equal(isConfidentialMode({ KCW_CONFIDENTIAL: value }), true, `value=${value}`);
  }
  for (const value of ['0', 'false', 'off', '', undefined]) {
    assert.equal(isConfidentialMode({ KCW_CONFIDENTIAL: value }), false, `value=${String(value)}`);
  }
  assert.equal(isConfidentialMode({}), false);
});

test('confidential forces air_gap and cannot be weakened by config or env mode', () => {
  const env = { KCW_CONFIDENTIAL: '1', KCW_SECURITY_MODE: 'controlled_hybrid' };
  assert.equal(resolveSecurityMode({ env }), 'air_gap');
  assert.equal(resolveSecurityMode({ configuredMode: 'local_demo', env }), 'air_gap');
  assert.equal(resolveSecurityMode({ configuredMode: 'controlled_hybrid', env }), 'air_gap');
  // 不开机密时既有语义不变
  assert.equal(resolveSecurityMode({ env: { KCW_SECURITY_MODE: 'controlled_hybrid' } }), 'controlled_hybrid');
  assert.equal(resolveSecurityMode({ configuredMode: 'local_strict', env: {} }), 'local_strict');
});

test('confidential denies cloud model providers and keeps local ones usable', () => {
  const env = { KCW_CONFIDENTIAL: '1' };
  const cloud = decideModelProviderPolicy({ provider: 'kimi-api', baseUrl: 'https://api.moonshot.cn/v1' }, { env });
  assert.equal(cloud.allowed, false);
  assert.equal(cloud.securityMode, 'air_gap');
  const local = decideModelProviderPolicy({ provider: 'openai/local', baseUrl: 'http://127.0.0.1:11434/v1' }, { env });
  assert.equal(local.allowed, true);
  assert.equal(local.providerClass, 'local');
});

test('confidential denies external network tools via the shared tool policy', () => {
  const env = { KCW_CONFIDENTIAL: '1' };
  assert.equal(decideToolPolicy({ toolName: 'WebSearch', env }).decision, 'deny');
  assert.equal(decideToolPolicy({ toolName: 'web.fetch', env }).decision, 'deny');
  assert.equal(decideToolPolicy({ toolName: 'Read', env }).decision, 'allow');
});

test('filterMcpServersForConfidential drops all startup MCP servers (incl. MASE) only in confidential mode', () => {
  const servers = [{ name: 'mase-memory' }, { name: 'other' }];
  const on = filterMcpServersForConfidential(servers, { KCW_CONFIDENTIAL: '1' });
  assert.deepEqual(on.servers, []);
  assert.equal(on.dropped.length, 2);
  assert.ok(on.reason, 'a human-readable reason is attached');
  const off = filterMcpServersForConfidential(servers, {});
  assert.deepEqual(off.servers, servers);
  assert.equal(off.dropped.length, 0);
});

test('HTTP surface: selfcheck exposes confidential + air_gap, OAuth routes are 403', async () => {
  const previous = process.env.KCW_CONFIDENTIAL;
  process.env.KCW_CONFIDENTIAL = '1';
  const root = tempRoot('kcw-confidential-');
  const server = createServer({ requireAuth: false, trustedRoot: root, enableScheduler: false, kimiChatRunner: noopKimiChatRunner });
  const base = await bind(server);
  try {
    const selfcheck = await jsonRequest(base, '/api/selfcheck');
    assert.equal(selfcheck.status, 200);
    const security = recordValue(selfcheck.body.security, 'selfcheck security');
    assert.equal(security.mode, 'air_gap');
    assert.equal(security.confidential, true);

    const oauth = await jsonRequest(base, '/api/connectors/oauth/status?provider=github');
    assert.equal(oauth.status, 403);
    assert.match(String(oauth.body.error || ''), /机密模式/);
  } finally {
    await close(server);
    if (previous === undefined) delete process.env.KCW_CONFIDENTIAL;
    else process.env.KCW_CONFIDENTIAL = previous;
  }
});

test('HTTP surface without confidential keeps selfcheck flag false and OAuth reachable', async () => {
  const previous = process.env.KCW_CONFIDENTIAL;
  delete process.env.KCW_CONFIDENTIAL;
  const root = tempRoot('kcw-confidential-off-');
  const server = createServer({ requireAuth: false, trustedRoot: root, enableScheduler: false, kimiChatRunner: noopKimiChatRunner });
  const base = await bind(server);
  try {
    const selfcheck = await jsonRequest(base, '/api/selfcheck');
    const security = recordValue(selfcheck.body.security, 'selfcheck security');
    assert.equal(security.confidential, false);
    const oauth = await jsonRequest(base, '/api/connectors/oauth/status?provider=github');
    assert.ok(oauth.status !== 403, 'oauth surface stays reachable outside confidential mode');
  } finally {
    await close(server);
    if (previous !== undefined) process.env.KCW_CONFIDENTIAL = previous;
  }
});
