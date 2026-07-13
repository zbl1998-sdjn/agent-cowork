import assert from 'node:assert/strict';
import test from 'node:test';
import { labelOs, resolveAgentEnvFacts, resolveAppVersion } from '../src/engine/agent-env.js';

test('labelOs maps common Node platform tokens to human-friendly names', () => {
  assert.equal(labelOs('win32'), 'Windows');
  assert.equal(labelOs('darwin'), 'macOS');
  assert.equal(labelOs('linux'), 'Linux');
});

test('labelOs passes through unknown platforms and treats falsy input as empty', () => {
  assert.equal(labelOs('freebsd'), 'freebsd');
  assert.equal(labelOs(''), '');
});

test('resolveAppVersion never returns empty (falls back to "dev")', () => {
  const value = resolveAppVersion();
  assert.equal(typeof value, 'string');
  assert.ok(value.length > 0, 'expected a non-empty version string');
});

test('resolveAppVersion prefers npm env, then SEA global, then dev', () => {
  const previousEnv = process.env.npm_package_version;
  const globalVersion = globalThis as typeof globalThis & { AGENT_COWORK_VERSION?: unknown };
  const previousGlobal = globalVersion.AGENT_COWORK_VERSION;
  try {
    process.env.npm_package_version = ' 1.2.3 ';
    globalVersion.AGENT_COWORK_VERSION = '9.9.9';
    assert.equal(resolveAppVersion(), '1.2.3');

    delete process.env.npm_package_version;
    globalVersion.AGENT_COWORK_VERSION = ' 2.0.0 ';
    assert.equal(resolveAppVersion(), '2.0.0');

    globalVersion.AGENT_COWORK_VERSION = '';
    assert.equal(resolveAppVersion(), 'dev');
  } finally {
    if (previousEnv === undefined) delete process.env.npm_package_version;
    else process.env.npm_package_version = previousEnv;
    if (previousGlobal === undefined) delete globalVersion.AGENT_COWORK_VERSION;
    else globalVersion.AGENT_COWORK_VERSION = previousGlobal;
  }
});

test('resolveAgentEnvFacts bundles platform + provider/model from modelConfig', () => {
  const facts = resolveAgentEnvFacts({
    trustedRoot: 'C:/work',
    modelConfig: { provider: 'kimi-api', model: 'kimi-k2-0905-preview' },
    now: new Date('2026-05-28T01:23:00Z'),
    platform: 'win32',
    appVersion: '0.2.0',
  });
  assert.equal(facts.trustedRoot, 'C:/work');
  assert.equal(facts.osName, 'Windows');
  assert.equal(facts.appVersion, '0.2.0');
  assert.equal(facts.provider, 'kimi-api');
  assert.equal(facts.model, 'kimi-k2-0905-preview');
  assert.ok(facts.now instanceof Date);
});

test('resolveAgentEnvFacts handles missing modelConfig + non-string trustedRoot defensively', () => {
  const facts = resolveAgentEnvFacts({ trustedRoot: null, modelConfig: null, platform: 'win32' });
  assert.equal(facts.trustedRoot, '');
  assert.equal(facts.osName, 'Windows');
  assert.equal(facts.provider, '');
  assert.equal(facts.model, '');
});

test('resolveAgentEnvFacts ignores malformed config and empty version overrides', () => {
  const facts = resolveAgentEnvFacts({
    trustedRoot: 42,
    modelConfig: { provider: 1, model: null },
    now: new Date('bad-date'),
    platform: 'plan9',
    appVersion: '',
  });

  assert.equal(facts.trustedRoot, '');
  assert.equal(facts.osName, 'plan9');
  assert.equal(facts.provider, '');
  assert.equal(facts.model, '');
  assert.equal(typeof facts.appVersion, 'string');
  assert.ok(facts.now instanceof Date);
});
