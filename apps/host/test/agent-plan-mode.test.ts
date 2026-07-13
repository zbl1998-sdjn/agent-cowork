import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { runAgentChat } from '../src/kimi/agent-runner.js';
import {
  hasTodoSnapshotText,
  parsePlanProposal,
  type EmittedEvent,
} from './helpers/agent.js';
import { createAgentApprovalRegistry, parseApprovalPayload } from './helpers/approvals.js';
import { tempRoot } from './helpers/host-http.js';
import { TEST_LOCAL_MODEL_CONFIG } from './helpers/kimi-config.js';
import type { ModelCall } from '../src/kimi/agent/model-resilience.js';

test('plan mode blocks writes until ExitPlanMode is approved, then executes', async () => {
  const root = tempRoot('kcw-agent-');
  const approvals = createAgentApprovalRegistry();
  const events: EmittedEvent[] = [];
  const emit = (type: string, payload: unknown) => {
    events.push({ type, payload });
    if (type === 'plan_proposed') {
      approvals.resolve(parsePlanProposal(payload).id, 'once');
    } else if (type === 'approval_request') {
      approvals.resolve(parseApprovalPayload(payload).id, 'once');
    }
  };
  let calls = 0;
  const modelCall: ModelCall = async () => {
    calls += 1;
    if (calls === 1) {
      return { content: '', tool_calls: [{ id: 'c1', function: { name: 'Write', arguments: JSON.stringify({ path: 'out.txt', content: 'EARLY' }) } }] };
    }
    if (calls === 2) {
      return { content: '', tool_calls: [{ id: 'c2', function: { name: 'ExitPlanMode', arguments: JSON.stringify({ plan: '1. 写 out.txt' }) } }] };
    }
    if (calls === 3) {
      return { content: '', tool_calls: [{ id: 'c3', function: { name: 'Write', arguments: JSON.stringify({ path: 'out.txt', content: 'APPROVED' }) } }] };
    }
    return { content: '已按计划完成。' };
  };

  const out = await runAgentChat({
    prompt: '写 out.txt',
    kimiConfig: TEST_LOCAL_MODEL_CONFIG,
    trustedRoot: root,
    modelCall,
    approvals,
    planMode: true,
    emit,
    runStoreRoot: path.join(root, 'runs'),
  });

  assert.ok(out.steps.some((step) => step.tool === 'Write' && step.planBlocked), 'early write blocked');
  assert.ok(events.some((event) => event.type === 'plan_proposed'), 'plan_proposed emitted');
  assert.ok(events.some((event) => event.type === 'approval_request'), 'post-plan write requested explicit approval');
  assert.ok(hasTodoSnapshotText(events, '写 out.txt'), 'plan todo snapshot emitted');
  assert.ok(out.steps.some((step) => step.tool === 'ExitPlanMode' && step.plan && step.approved), 'plan approved');
  assert.equal(fs.readFileSync(path.join(root, 'out.txt'), 'utf8'), 'APPROVED');
  assert.equal(out.text, '已按计划完成。');
});

test('plan mode: rejecting the plan keeps mutating tools blocked', async () => {
  const root = tempRoot('kcw-agent-');
  const approvals = createAgentApprovalRegistry();
  let planProposals = 0;
  const emit = (type: string, payload: unknown) => {
    if (type !== 'plan_proposed') return;
    planProposals += 1;
    approvals.resolve(parsePlanProposal(payload).id, 'reject');
  };
  let calls = 0;
  const modelCall: ModelCall = async () => {
    calls += 1;
    if (calls === 1) {
      return { content: '', tool_calls: [{ id: 'c1', function: { name: 'ExitPlanMode', arguments: JSON.stringify({ plan: '改 out.txt' }) } }] };
    }
    if (calls === 2) {
      return { content: '', tool_calls: [{ id: 'c2', function: { name: 'Write', arguments: JSON.stringify({ path: 'out.txt', content: 'NOPE' }) } }] };
    }
    return { content: '好的，我再完善计划。' };
  };

  const out = await runAgentChat({
    prompt: '改 out.txt',
    kimiConfig: TEST_LOCAL_MODEL_CONFIG,
    trustedRoot: root,
    modelCall,
    approvals,
    planMode: true,
    emit,
    runStoreRoot: path.join(root, 'runs'),
  });

  assert.equal(planProposals, 1);
  assert.ok(out.steps.some((step) => step.tool === 'ExitPlanMode' && step.approved === false), 'plan rejected');
  assert.ok(out.steps.some((step) => step.tool === 'Write' && step.planBlocked), 'write still blocked after reject');
  assert.equal(fs.existsSync(path.join(root, 'out.txt')), false, 'file never written');
});
