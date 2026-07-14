// 数据销毁/保留 HTTP 面(切片 2d)——plan 只读、purge 需 confirm、jail 固定服务端
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createServer } from '../src/server.js';
import { noopKimiChatRunner } from './helpers/agent-stream.js';
import { bind, close, jsonRequest, recordValue, tempRoot } from './helpers/host-http.js';

function seed(root: string): void {
  const A = path.join(root, '.AgentCowork');
  fs.mkdirSync(path.join(A, 'conversations', 't', 'u'), { recursive: true });
  fs.mkdirSync(path.join(A, 'security'), { recursive: true });
  fs.writeFileSync(path.join(A, 'conversations', 't', 'u', 'c1.json'), '{"id":"c1"}');
  fs.writeFileSync(path.join(A, 'security', 'at-rest.key'), 'aesgcm:v1:...');
}

test('purge-plan is read-only; purge requires confirm; key store survives content purge', async () => {
  const root = tempRoot('kcw-purge-route-');
  seed(root);
  const server = createServer({ requireAuth: false, trustedRoot: root, enableScheduler: false, modelChatRunner: noopKimiChatRunner });
  const base = await bind(server);
  try {
    const plan = await jsonRequest(base, '/api/security/data/purge-plan', { method: 'POST', body: { scope: 'content' } });
    assert.equal(plan.status, 200);
    assert.equal(recordValue(plan.body.plan, 'plan').executed, false);
    assert.ok(fs.existsSync(path.join(root, '.AgentCowork', 'conversations')), 'plan must not delete');

    const noConfirm = await jsonRequest(base, '/api/security/data/purge', { method: 'POST', body: { scope: 'content' } });
    assert.equal(noConfirm.status, 428, 'purge without confirm is refused');
    assert.ok(fs.existsSync(path.join(root, '.AgentCowork', 'conversations')));

    const done = await jsonRequest(base, '/api/security/data/purge', { method: 'POST', body: { scope: 'content', confirm: true } });
    assert.equal(done.status, 200);
    assert.ok(!fs.existsSync(path.join(root, '.AgentCowork', 'conversations')), 'content purged');
    assert.ok(fs.existsSync(path.join(root, '.AgentCowork', 'security')), 'key store kept by content scope');

    const bad = await jsonRequest(base, '/api/security/data/purge-plan', { method: 'POST', body: { scope: 'evil' } });
    assert.equal(bad.status, 400);
  } finally {
    await close(server);
  }
});
