import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from '../src/server.js';
import {
  approvalOkResponseSchema,
  callThenAnswer,
  drainStream,
  parseJson,
  readApprovalRequest,
  scopedJsonHeaders,
} from './helpers/approvals.js';
import { noopKimiChatRunner } from './helpers/agent-stream.js';
import { bind, close, readableBody, tempRoot } from './helpers/host-http.js';

test('POST /api/agent/chat/stream gates Shell, proceeds after POST /api/approvals/:id', async () => {
  const root = tempRoot('kcw-apr-');
  const agentModelCall = callThenAnswer('Shell', { command: 'node -e "process.stdout.write(String(1+1))"' });
  const server = createServer({ trustedRoot: root, enableScheduler: false, kimiChatRunner: noopKimiChatRunner, agentModelCall });
  const base = await bind(server);
  try {
    const response = await fetch(`${base}/api/agent/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'run a command' }),
    });
    const reader = readableBody(response, 'agent stream response').getReader();
    const approval = await readApprovalRequest(reader);
    assert.ok(approval.approvalId, 'Shell triggered an approval_request');

    const approvalResponse = await fetch(`${base}/api/approvals/${approval.approvalId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'once' }),
    });
    assert.equal((await parseJson(approvalResponse, approvalOkResponseSchema)).ok, true);

    const fullStream = await drainStream(reader, approval.text);
    assert.match(fullStream, /event: done/);
  } finally {
    await close(server);
  }
});

test('POST /api/approvals/:id rejects a different tenant before resolving a tool approval', async () => {
  const root = tempRoot('kcw-apr-');
  const agentModelCall = callThenAnswer('Shell', { command: 'node -e "process.stdout.write(String(1+1))"' });
  const server = createServer({
    trustedRoot: root,
    enableScheduler: false,
    requireAuth: true,
    trustIdentityHeaders: true,
    kimiChatRunner: noopKimiChatRunner,
    agentModelCall,
  });
  const base = await bind(server);
  try {
    const ownerHeaders = scopedJsonHeaders('tenant_a', 'user_a');
    const response = await fetch(`${base}/api/agent/chat/stream`, {
      method: 'POST',
      headers: ownerHeaders,
      body: JSON.stringify({ prompt: 'run a command' }),
    });
    const reader = readableBody(response, 'agent stream response').getReader();
    const approval = await readApprovalRequest(reader);
    assert.ok(approval.approvalId, 'Shell triggered an approval_request');

    const wrong = await fetch(`${base}/api/approvals/${approval.approvalId}`, {
      method: 'POST',
      headers: scopedJsonHeaders('tenant_b', 'user_b'),
      body: JSON.stringify({ decision: 'once' }),
    });
    assert.equal(wrong.status, 404, 'different tenant cannot resolve the approval');
    assert.equal((await parseJson(wrong, approvalOkResponseSchema)).ok, false);

    const owner = await fetch(`${base}/api/approvals/${approval.approvalId}`, {
      method: 'POST',
      headers: ownerHeaders,
      body: JSON.stringify({ decision: 'once' }),
    });
    assert.equal(owner.status, 200);
    assert.equal((await parseJson(owner, approvalOkResponseSchema)).ok, true);

    const fullStream = await drainStream(reader, approval.text);
    assert.match(fullStream, /event: done/);
  } finally {
    await close(server);
  }
});
