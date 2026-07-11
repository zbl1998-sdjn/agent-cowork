import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { runAgentChat } from '../src/kimi/agent-runner.js';
import { callThenAnswer, createAgentApprovalRegistry, mutatingTool, parseApprovalPayload, tool } from './helpers/approvals.js';
import { tempRoot } from './helpers/host-http.js';
import { TEST_LOCAL_MODEL_CONFIG } from './helpers/kimi-config.js';

test('high-risk tool is gated behind approval (approve once)', async () => {
  let executed = false;
  const approvals = createAgentApprovalRegistry();
  let asked = 0;
  const root = tempRoot('kcw-apr-');
  const out = await runAgentChat({
    prompt: 'x',
    kimiConfig: TEST_LOCAL_MODEL_CONFIG,
    trustedRoot: root,
    runStoreRoot: path.join(root, 'runs'),
    tools: [tool('Shell', 'high', () => { executed = true; })],
    modelCall: callThenAnswer('Shell'),
    approvals,
    emit: (type, payload) => {
      if (type === 'approval_request') {
        asked += 1;
        approvals.resolve(parseApprovalPayload(payload).id, 'once');
      }
    },
  });
  assert.equal(asked, 1);
  assert.equal(executed, true);
  assert.equal(out.text, '完成。');
});

test('rejected high-risk tool does not run', async () => {
  let executed = false;
  const approvals = createAgentApprovalRegistry();
  const root = tempRoot('kcw-apr-');
  const out = await runAgentChat({
    prompt: 'x',
    kimiConfig: TEST_LOCAL_MODEL_CONFIG,
    trustedRoot: root,
    runStoreRoot: path.join(root, 'runs'),
    tools: [tool('Shell', 'high', () => { executed = true; })],
    modelCall: callThenAnswer('Shell'),
    approvals,
    emit: (type, payload) => {
      if (type === 'approval_request') approvals.resolve(parseApprovalPayload(payload).id, 'reject');
    },
  });
  assert.equal(executed, false);
  assert.ok(out.steps.some((step) => step.tool === 'Shell' && step.rejected));
});

test('requiresApproval and critical risk tools are gated even when not mutating', async () => {
  const root = tempRoot('kcw-apr-');
  const approvals = createAgentApprovalRegistry();
  let gatedRan = false;
  let criticalRan = false;
  let asked = 0;
  const out = await runAgentChat({
    prompt: 'x',
    kimiConfig: TEST_LOCAL_MODEL_CONFIG,
    trustedRoot: root,
    runStoreRoot: path.join(root, 'runs'),
    tools: [
      { name: 'NeedsReceipt', risk: 'low', requiresApproval: true, description: 'receipt', parameters: { type: 'object', properties: {} }, handler: async () => { gatedRan = true; return { ok: true }; } },
      { name: 'CriticalRead', risk: 'critical', mutating: false, description: 'critical', parameters: { type: 'object', properties: {} }, handler: async () => { criticalRan = true; return { ok: true }; } },
    ],
    modelCall: callThenAnswer('NeedsReceipt'),
    approvals,
    emit: (type, payload) => {
      if (type === 'approval_request') {
        asked += 1;
        approvals.resolve(parseApprovalPayload(payload).id, 'reject');
      }
    },
  });
  assert.equal(asked, 1);
  assert.equal(gatedRan, false);
  assert.equal(criticalRan, false);
  assert.ok(out.steps.some((step) => step.tool === 'NeedsReceipt' && step.rejected));

  const approvals2 = createAgentApprovalRegistry();
  await runAgentChat({
    prompt: 'x',
    kimiConfig: TEST_LOCAL_MODEL_CONFIG,
    trustedRoot: root,
    runStoreRoot: path.join(root, 'runs2'),
    tools: [
      { name: 'CriticalRead', risk: 'critical', mutating: false, description: 'critical', parameters: { type: 'object', properties: {} }, handler: async () => { criticalRan = true; return { ok: true }; } },
    ],
    modelCall: callThenAnswer('CriticalRead'),
    approvals: approvals2,
    emit: (type, payload) => {
      if (type === 'approval_request') approvals2.resolve(parseApprovalPayload(payload).id, 'reject');
    },
  });
  assert.equal(criticalRan, false);
});

test('low-risk tool runs without approval', async () => {
  let executed = false;
  const approvals = createAgentApprovalRegistry();
  let asked = 0;
  const root = tempRoot('kcw-apr-');
  await runAgentChat({
    prompt: 'x',
    kimiConfig: TEST_LOCAL_MODEL_CONFIG,
    trustedRoot: root,
    runStoreRoot: path.join(root, 'runs'),
    tools: [tool('Write', 'low', () => { executed = true; })],
    modelCall: callThenAnswer('Write'),
    approvals,
    emit: (type) => {
      if (type === 'approval_request') asked += 1;
    },
  });
  assert.equal(asked, 0, 'low-risk tool must not prompt for approval');
  assert.equal(executed, true);
});

test('autoApprove auto-approves non-high mutations but high-risk stays explicit', async () => {
  const approvals = createAgentApprovalRegistry();
  let writeRan = false;
  let askedFor: string | null = null;
  const root = tempRoot('kcw-apr-');
  await runAgentChat({
    prompt: 'x',
    kimiConfig: TEST_LOCAL_MODEL_CONFIG,
    trustedRoot: root,
    runStoreRoot: path.join(root, 'runs'),
    tools: [mutatingTool('SaveDraft', 'write', () => { writeRan = true; })],
    modelCall: callThenAnswer('SaveDraft'),
    approvals,
    autoApprove: true,
    emit: (type, payload) => {
      if (type === 'approval_request') askedFor = parseApprovalPayload(payload).name ?? null;
    },
  });
  assert.equal(askedFor, null, 'non-high mutation is auto-approved under autoApprove');
  assert.equal(writeRan, true);

  const approvals2 = createAgentApprovalRegistry();
  let shellRan = false;
  let asked = 0;
  await runAgentChat({
    prompt: 'x',
    kimiConfig: TEST_LOCAL_MODEL_CONFIG,
    trustedRoot: root,
    runStoreRoot: path.join(root, 'runs'),
    tools: [mutatingTool('Shell', 'high', () => { shellRan = true; })],
    modelCall: callThenAnswer('Shell'),
    approvals: approvals2,
    autoApprove: true,
    emit: (type, payload) => {
      if (type === 'approval_request') {
        asked += 1;
        approvals2.resolve(parseApprovalPayload(payload).id, 'reject');
      }
    },
  });
  assert.equal(asked, 1, 'high-risk still prompts under autoApprove');
  assert.equal(shellRan, false, 'rejected high-risk does not run even under autoApprove');
});
