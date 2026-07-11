import assert from 'node:assert/strict';
import test from 'node:test';

import {
  approvalScope,
  recordUnavailableApproval,
} from '../src/kimi/agent/approval-support.js';
import {
  createTrustedInProcessModelCallCapability,
  grantsTrustedInProcessModelCall,
} from '../src/kimi/agent/model-call-capability.js';
import { resolveOrchestratorSecurityMode } from '../src/routes/orchestrator-security-mode.js';
import { MODEL_EGRESS_APPROVAL_CAPABILITY } from '../src/security/model-egress-approval.js';
import {
  isCustomerGatewayHostAllowed,
  isPrivateModelHost,
} from '../src/security/model-gateway-policy.js';

test('in-process model capabilities are unforgeable and bound to one function', () => {
  const first = async () => ({ content: 'first' });
  const second = async () => ({ content: 'second' });
  assert.throws(
    () => createTrustedInProcessModelCallCapability({} as never),
    /requires a function/,
  );

  const capability = createTrustedInProcessModelCallCapability(first);
  assert.equal(Object.isFrozen(capability), true);
  assert.equal(Object.getPrototypeOf(capability), null);
  assert.equal(grantsTrustedInProcessModelCall(capability, first), true);
  assert.equal(grantsTrustedInProcessModelCall(capability, second), false);
  assert.equal(grantsTrustedInProcessModelCall(Object.freeze({}), first), false);
  assert.equal(grantsTrustedInProcessModelCall(null, first), false);
});

test('unavailable approval records remain scoped and fail closed', () => {
  assert.deepEqual(approvalScope(), {});
  assert.deepEqual(approvalScope({ tenantId: 'tenant-a' }), { tenantId: 'tenant-a' });
  assert.deepEqual(approvalScope({ userId: 'user-a' }), { userId: 'user-a' });
  assert.deepEqual(
    approvalScope({ tenantId: 'tenant-a', userId: 'user-a', ignored: true }),
    { tenantId: 'tenant-a', userId: 'user-a' },
  );

  const steps: Array<Record<string, unknown>> = [];
  const messages: Array<Record<string, unknown>> = [];
  const audits: Array<[string, Record<string, unknown> | undefined]> = [];
  const events: Array<[string, Record<string, unknown>]> = [];
  recordUnavailableApproval({
    name: 'Shell',
    steps,
    messages,
    call: { id: 'call-1' },
    audit: (kind, details) => audits.push([kind, details]),
    emit: (kind, payload) => events.push([kind, payload]),
  }, 'approval service unavailable', 'approval_unavailable', { requestId: 'req-1' });

  assert.deepEqual(steps, [{ tool: 'Shell', ok: false, approvalUnavailable: true }]);
  assert.deepEqual(audits, [['approval_unavailable', { requestId: 'req-1' }]]);
  assert.equal(events[0]?.[0], 'tool_result');
  assert.deepEqual(JSON.parse(String(messages[0]?.content)), {
    error: 'approval service unavailable',
    code: 'APPROVAL_REQUIRED',
  });
});

test('model egress approval requirements are immutable and receipt-bound', () => {
  assert.deepEqual(MODEL_EGRESS_APPROVAL_CAPABILITY, {
    status: 'unavailable',
    reasonCode: 'model_egress_approval_receipt_unavailable',
    requiredBindings: ['scope', 'ttl', 'single_use', 'endpoint', 'content'],
  });
  assert.equal(Object.isFrozen(MODEL_EGRESS_APPROVAL_CAPABILITY), true);
  assert.equal(Object.isFrozen(MODEL_EGRESS_APPROVAL_CAPABILITY.requiredBindings), true);
});

test('customer gateway allowlists reject ambiguous patterns and private-host guessing', () => {
  for (const host of [
    '10.0.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    'fd00::1',
    'fec0::1',
    'model.internal',
    'model.corp',
    'model.local',
    'model.lan',
  ]) {
    assert.equal(isPrivateModelHost(host), true, host);
  }
  for (const host of ['8.8.8.8', '172.32.0.1', 'example.com', '999.1.1.1']) {
    assert.equal(isPrivateModelHost(host), false, host);
  }

  const env = {
    KCW_CUSTOMER_MODEL_GATEWAY_HOSTS: [
      'models.example.com.',
      '*.gateway.corp',
      '[2001:4860:4860::8888]',
      '*.10.0.0.1',
      '*.*.invalid',
      'https://bad.example',
      'user@bad.example',
      'bad.example/path',
      'bad.example:443',
    ].join(','),
  };
  assert.equal(isCustomerGatewayHostAllowed('MODELS.EXAMPLE.COM', env), true);
  assert.equal(isCustomerGatewayHostAllowed('east.gateway.corp', env), true);
  assert.equal(isCustomerGatewayHostAllowed('gateway.corp', env), false);
  assert.equal(isCustomerGatewayHostAllowed('gateway.corp.evil.example', env), false);
  assert.equal(isCustomerGatewayHostAllowed('[2001:4860:4860::8888]', env), true);
  assert.equal(isCustomerGatewayHostAllowed('10.0.0.1', env), false);
  assert.equal(isCustomerGatewayHostAllowed('', env), false);
});

test('orchestrator mode adapter ignores request-owned cloud aliases except the legacy internal value', () => {
  assert.equal(resolveOrchestratorSecurityMode({ securityMode: 'cloud-opt-in' }), 'cloud_opt_in');
  assert.equal(resolveOrchestratorSecurityMode({ securityMode: 'controlled hybrid' }), 'cloud_opt_in');
  assert.equal(resolveOrchestratorSecurityMode({ securityMode: 'enterprise_local' }), 'enterprise_hybrid');
  assert.equal(resolveOrchestratorSecurityMode({ securityMode: 'local_strict' }), 'local_strict');
  assert.equal(resolveOrchestratorSecurityMode({ securityMode: 'unknown' }), 'local_strict');
  assert.equal(resolveOrchestratorSecurityMode({}), 'local_strict');
});
