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
  assert.equal(classifyModelProvider({ provider: 'openai/local', baseUrl: 'https://models.example.com/v1' }), 'external_provider');
  assert.equal(classifyModelProvider({ baseUrl: 'https://llm-gateway.corp/v1' }), 'external_provider');
  assert.equal(classifyModelProvider({ baseUrl: 'https://models.example.com/v1' }, {
    env: { KCW_CUSTOMER_MODEL_GATEWAY_HOSTS: 'models.example.com' },
  }), 'customer_gateway');
  assert.equal(classifyModelProvider({ provider: 'kimi-api', baseUrl: 'https://api.moonshot.ai/v1' }), 'external_provider');
});

test('customer gateway classification requires an explicit exact or controlled wildcard allowlist', () => {
  for (const baseUrl of [
    'https://10.0.0.7/v1',
    'https://172.20.0.7/v1',
    'https://192.168.1.7/v1',
    'https://llm.internal/v1',
    'https://llm.corp/v1',
    'https://llm.local/v1',
    'https://llm.lan/v1',
  ]) {
    assert.equal(classifyModelProvider({ baseUrl }, { env: {} }), 'external_provider', baseUrl);
  }

  const exactEnv = { KCW_CUSTOMER_MODEL_GATEWAY_HOSTS: 'models.example.com,10.0.0.7' };
  assert.equal(classifyModelProvider({ baseUrl: 'https://models.example.com/v1' }, { env: exactEnv }), 'customer_gateway');
  assert.equal(classifyModelProvider({ baseUrl: 'https://sub.models.example.com/v1' }, { env: exactEnv }), 'external_provider');
  assert.equal(classifyModelProvider({ baseUrl: 'https://10.0.0.7/v1' }, { env: exactEnv }), 'customer_gateway');

  const wildcardEnv = { KCW_CUSTOMER_MODEL_GATEWAY_HOSTS: '*.gateway.corp' };
  assert.equal(classifyModelProvider({ baseUrl: 'https://east.gateway.corp/v1' }, { env: wildcardEnv }), 'customer_gateway');
  assert.equal(classifyModelProvider({ baseUrl: 'https://gateway.corp/v1' }, { env: wildcardEnv }), 'external_provider');
  assert.equal(classifyModelProvider({ baseUrl: 'https://gateway.corp.evil.example/v1' }, { env: wildcardEnv }), 'external_provider');
});

test('unallowlisted private and internal model destinations are policy denials', () => {
  for (const baseUrl of ['https://10.0.0.7/v1', 'https://llm.internal/v1', 'https://llm.corp/v1']) {
    const decision = decideModelProviderPolicy({
      securityMode: 'controlled_hybrid',
      provider: 'custom-openai-compatible',
      baseUrl,
      model: 'private-model',
    }, { env: {} });
    assert.equal(decision.allowed, false, baseUrl);
    assert.equal(decision.decision, 'deny', baseUrl);
    assert.equal(decision.reasonCode, 'model_base_url_private_destination_not_allowlisted', baseUrl);
  }
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

test('model provider policy rejects unsupported and link-local model endpoints before mode rules', () => {
  const metadata = decideModelProviderPolicy({
    securityMode: 'controlled_hybrid',
    provider: 'openai/local',
    baseUrl: 'http://169.254.169.254/latest/meta-data',
    model: 'metadata-probe',
  });
  assert.equal(metadata.allowed, false);
  assert.equal(metadata.decision, 'deny');
  assert.equal(metadata.reasonCode, 'model_base_url_unsafe_destination');

  const unsupported = decideModelProviderPolicy({
    securityMode: 'controlled_hybrid',
    provider: 'openai/local',
    baseUrl: 'file:///etc/passwd',
    model: 'unsupported-scheme',
  });
  assert.equal(unsupported.allowed, false);
  assert.equal(unsupported.decision, 'deny');
  assert.equal(unsupported.reasonCode, 'model_base_url_unsupported_protocol');
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
