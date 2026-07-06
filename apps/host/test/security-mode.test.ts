import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyModelProvider,
  decideModelProviderPolicy,
  filterModelCandidatesBySecurityMode,
  normalizeSecurityMode,
  resolveSecurityMode,
} from '../src/security/security-mode.js';

test('security mode normalization is explicit and defaults to controlled hybrid', () => {
  assert.equal(normalizeSecurityMode('LOCAL-STRICT'), 'local_strict');
  assert.equal(normalizeSecurityMode('air gap'), 'air_gap');
  assert.equal(resolveSecurityMode({ env: { SECURITY_MODE: 'enterprise_hybrid' } }), 'enterprise_local');
  assert.equal(resolveSecurityMode({ env: { SECURITY_MODE: 'saas_opt_in' } }), 'controlled_hybrid');
  assert.equal(resolveSecurityMode({ env: {} }), 'controlled_hybrid');
});

test('model provider classifier separates local, customer gateway, and external providers', () => {
  assert.equal(classifyModelProvider({ provider: 'openai/local' }), 'local');
  assert.equal(classifyModelProvider({ provider: 'lmstudio' }), 'local');
  assert.equal(classifyModelProvider({ baseUrl: 'http://127.0.0.1:11434/v1' }), 'local');
  assert.equal(classifyModelProvider({ baseUrl: 'https://llm-gateway.corp/v1' }), 'customer_gateway');
  assert.equal(classifyModelProvider({ baseUrl: 'https://models.example.com/v1' }, {
    env: { KCW_CUSTOMER_MODEL_GATEWAY_HOSTS: 'models.example.com' },
  }), 'customer_gateway');
  assert.equal(classifyModelProvider({ provider: 'kimi-api', baseUrl: 'https://api.moonshot.ai/v1' }), 'external_provider');
});

test('model provider policy blocks non-local providers in local strict mode', () => {
  const denied = decideModelProviderPolicy({
    securityMode: 'local_strict',
    provider: 'kimi-api',
    baseUrl: 'https://api.moonshot.ai/v1',
    model: 'kimi-k2.6',
  });
  assert.equal(denied.allowed, false);
  assert.equal(denied.reasonCode, 'local_strict_model_must_be_local');

  const allowed = decideModelProviderPolicy({
    securityMode: 'local_strict',
    provider: 'openai/local',
    baseUrl: 'http://localhost:11434/v1',
    model: 'local-model',
  });
  assert.equal(allowed.allowed, true);
});

test('controlled hybrid marks external providers as approval-gated', () => {
  const decision = decideModelProviderPolicy({
    securityMode: 'controlled_hybrid',
    provider: 'kimi-api',
    baseUrl: 'https://api.moonshot.ai/v1',
    model: 'kimi-k2.7-code',
  });

  assert.equal(decision.allowed, true);
  assert.equal(decision.decision, 'needs_approval');
  assert.equal(decision.reasonCode, 'controlled_hybrid_external_provider_needs_preview');
});

test('model candidate filter drops denied external providers before runtime calls', () => {
  const filtered = filterModelCandidatesBySecurityMode([
    { securityMode: 'local_strict', provider: 'kimi-api', baseUrl: 'https://api.moonshot.ai/v1', model: 'external' },
    { securityMode: 'local_strict', provider: 'openai/local', baseUrl: 'http://127.0.0.1:11434/v1', model: 'local' },
  ]);

  assert.deepEqual(filtered.candidates.map((item) => item.model), ['local']);
  assert.equal(filtered.denied.length, 1);
  assert.equal(filtered.denied[0]?.policy.reasonCode, 'local_strict_model_must_be_local');
});
