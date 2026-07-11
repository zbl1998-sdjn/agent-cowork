import assert from 'node:assert/strict';
import test from 'node:test';
import { createApprovalRegistry } from '../src/runtime/approvals.js';
import { createServer } from '../src/server.js';
import {
  approvalBatchResponseSchema,
  approvalErrorResponseSchema,
  approvalOkResponseSchema,
  parseJson,
  scopedJsonHeaders,
} from './helpers/approvals.js';
import { bind, close, tempRoot } from './helpers/host-http.js';

test('POST /api/approvals/batch resolves only exact IDs in the caller scope', async () => {
  const root = tempRoot('kcw-apr-');
  const approvalRegistry = createApprovalRegistry();
  const first = approvalRegistry.request({ name: 'Shell', tenantId: 'tenant_a', userId: 'user_a' });
  const second = approvalRegistry.request({ name: 'Write', tenantId: 'tenant_a', userId: 'user_a' });
  const server = createServer({
    trustedRoot: root,
    enableScheduler: false,
    requireAuth: true,
    trustIdentityHeaders: true,
    approvalRegistry,
  });
  const base = await bind(server);
  try {
    const wrong = await fetch(`${base}/api/approvals/batch`, {
      method: 'POST',
      headers: scopedJsonHeaders('tenant_b', 'user_b'),
      body: JSON.stringify({ ids: [first.id, second.id], decision: 'once' }),
    });
    assert.equal(wrong.status, 404, 'different tenant cannot batch-resolve approvals');
    const wrongBody = await parseJson(wrong, approvalBatchResponseSchema);
    assert.equal(wrongBody.context.tenantId, 'tenant_b');
    assert.equal(wrongBody.context.userId, 'user_b');
    assert.deepEqual(wrongBody.ids, [first.id, second.id]);
    assert.equal(wrongBody.ok, false);
    assert.equal(wrongBody.resolved, 0);
    assert.deepEqual(wrongBody.results, [{ id: first.id, ok: false }, { id: second.id, ok: false }]);
    assert.equal(wrongBody.decision, 'once');

    const owner = await fetch(`${base}/api/approvals/batch`, {
      method: 'POST',
      headers: scopedJsonHeaders('tenant_a', 'user_a'),
      body: JSON.stringify({ ids: [first.id, 'ghost', second.id, first.id], decision: 'session' }),
    });
    assert.equal(owner.status, 200);
    const ownerBody = await parseJson(owner, approvalBatchResponseSchema);
    assert.equal(ownerBody.context.tenantId, 'tenant_a');
    assert.equal(ownerBody.context.userId, 'user_a');
    assert.deepEqual(ownerBody.ids, [first.id, 'ghost', second.id]);
    assert.equal(ownerBody.ok, false);
    assert.equal(ownerBody.resolved, 2);
    assert.deepEqual(ownerBody.results, [{ id: first.id, ok: true }, { id: 'ghost', ok: false }, { id: second.id, ok: true }]);
    assert.equal(ownerBody.decision, 'session');
    assert.equal(await first.promise, 'session');
    assert.equal(await second.promise, 'session');
  } finally {
    await close(server);
  }
});

test('POST /api/approvals/batch rejects invalid ids', async () => {
  const root = tempRoot('kcw-apr-');
  const approvalRegistry = createApprovalRegistry();
  const server = createServer({ trustedRoot: root, enableScheduler: false, requireAuth: false, approvalRegistry });
  const base = await bind(server);
  try {
    const invalid = await fetch(`${base}/api/approvals/batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: ['apr_ok', '../bad'], decision: 'once' }),
    });
    assert.equal(invalid.status, 400);
    assert.match((await parseJson(invalid, approvalErrorResponseSchema)).error, /ids/i);

    const invalidDecision = await fetch(`${base}/api/approvals/batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: ['apr_ok'], decision: 'approve' }),
    });
    assert.equal(invalidDecision.status, 400);
    assert.match((await parseJson(invalidDecision, approvalErrorResponseSchema)).error, /decision/i);

    const empty = await fetch(`${base}/api/approvals/batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [], decision: 'once' }),
    });
    assert.equal(empty.status, 400);
  } finally {
    await close(server);
  }
});

test('POST /api/approvals/:id separates question answers from approval decisions', async () => {
  const root = tempRoot('kcw-apr-');
  const approvalRegistry = createApprovalRegistry();
  const server = createServer({ trustedRoot: root, enableScheduler: false, requireAuth: false, approvalRegistry });
  const base = await bind(server);
  try {
    const tool = approvalRegistry.request({
      kind: 'tool',
      name: 'Shell',
      tenantId: 'tenant_local',
      userId: 'user_local',
    });
    const answerTool = await fetch(`${base}/api/approvals/${tool.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answer: 'arbitrary answer' }),
    });
    assert.equal(answerTool.status, 404);
    assert.equal((await parseJson(answerTool, approvalOkResponseSchema)).ok, false);

    const invalidDecision = await fetch(`${base}/api/approvals/${tool.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'approve' }),
    });
    assert.equal(invalidDecision.status, 400);
    assert.match((await parseJson(invalidDecision, approvalErrorResponseSchema)).error, /decision/i);

    const approveTool = await fetch(`${base}/api/approvals/${tool.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'once' }),
    });
    assert.equal(approveTool.status, 200);
    assert.equal(await tool.promise, 'once');

    const question = approvalRegistry.request({
      kind: 'question',
      question: 'Which format?',
      tenantId: 'tenant_local',
      userId: 'user_local',
    });
    const decideQuestion = await fetch(`${base}/api/approvals/${question.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'once' }),
    });
    assert.equal(decideQuestion.status, 404);

    const answerQuestion = await fetch(`${base}/api/approvals/${question.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answer: 'Excel' }),
    });
    assert.equal(answerQuestion.status, 200);
    assert.equal(await question.promise, 'Excel');
  } finally {
    await close(server);
  }
});
