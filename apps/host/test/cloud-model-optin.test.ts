import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  applyCloudOptInToEnv,
  cloudOptInHosts,
  GATEWAY_HOSTS_ENV,
  hostOf,
  listCloudProviders,
  readCloudOptIn,
  setCloudOptIn,
} from '../src/engine/provider/cloud-model-optin.js';
import { decideModelProviderPolicy } from '../src/security/security-mode.js';

function makeRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'acw-cloudoptin-'));
}

test('opt-in persists enabled cloud providers and rejects local/unknown ones', () => {
  const root = makeRoot();
  assert.deepEqual(readCloudOptIn(root), { enabled: false, providers: [] });

  const saved = setCloudOptIn(root, { enabled: true, providers: ['deepseek', 'openai'] });
  assert.deepEqual(saved, { enabled: true, providers: ['deepseek', 'openai'] });
  assert.deepEqual(readCloudOptIn(root), { enabled: true, providers: ['deepseek', 'openai'] });

  assert.throws(() => setCloudOptIn(root, { enabled: true, providers: ['ollama'] }), /不是可启用的云端 provider/);
  assert.throws(() => setCloudOptIn(root, { enabled: true, providers: ['not-a-provider'] }), /不是可启用的云端 provider/);
});

test('hostOf and listCloudProviders resolve public hosts, excluding local runtimes', () => {
  assert.equal(hostOf('deepseek'), 'api.deepseek.com');
  assert.equal(hostOf('openai'), 'api.openai.com');
  assert.equal(hostOf('ollama'), '127.0.0.1');
  const cloud = listCloudProviders();
  assert.ok(cloud.some((p) => p.id === 'deepseek' && p.host === 'api.deepseek.com'));
  assert.ok(!cloud.some((p) => p.id === 'ollama'), 'local runtimes are not offered as cloud opt-ins');
});

test('applyCloudOptInToEnv layers user hosts over the admin baseline and falls back when disabled', () => {
  const root = makeRoot();
  const env: Record<string, string | undefined> = {};

  // disabled -> only baseline
  setCloudOptIn(root, { enabled: false, providers: ['deepseek'] });
  applyCloudOptInToEnv(root, 'gateway.corp.example', env);
  assert.equal(env[GATEWAY_HOSTS_ENV], 'gateway.corp.example');

  // enabled -> baseline + provider hosts
  setCloudOptIn(root, { enabled: true, providers: ['deepseek', 'openai'] });
  applyCloudOptInToEnv(root, 'gateway.corp.example', env);
  const hosts = String(env[GATEWAY_HOSTS_ENV]).split(',');
  assert.ok(hosts.includes('gateway.corp.example'), 'admin baseline is preserved');
  assert.ok(hosts.includes('api.deepseek.com') && hosts.includes('api.openai.com'));

  // toggling back off restores just the baseline (never clobbers admin allowlist)
  setCloudOptIn(root, { enabled: false, providers: ['deepseek', 'openai'] });
  applyCloudOptInToEnv(root, 'gateway.corp.example', env);
  assert.equal(env[GATEWAY_HOSTS_ENV], 'gateway.corp.example');

  assert.deepEqual(cloudOptInHosts({ enabled: false, providers: ['deepseek'] }), []);
});

test('enabling a cloud provider flips the egress policy from blocked to allowed in controlled_hybrid', () => {
  const env: Record<string, string | undefined> = {};
  const config = { provider: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4' };

  // default: external provider is not allowed to just go out
  const before = decideModelProviderPolicy(config, { securityMode: 'controlled_hybrid', env });
  assert.notEqual(before.decision, 'allow');

  // user enables deepseek -> host lands in the gateway allowlist -> classified customer_gateway -> allowed
  env[GATEWAY_HOSTS_ENV] = 'api.deepseek.com';
  const after = decideModelProviderPolicy(config, { securityMode: 'controlled_hybrid', env });
  assert.equal(after.decision, 'allow');
});
