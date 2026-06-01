import assert from 'node:assert/strict';
import test from 'node:test';
import { labelOs, resolveAgentEnvFacts, resolveAppVersion } from '../src/kimi/agent-env.js';

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

test('resolveAgentEnvFacts bundles platform + provider/model from kimiConfig', () => {
  const facts = resolveAgentEnvFacts({
    trustedRoot: 'C:/work',
    kimiConfig: { provider: 'kimi-api', model: 'kimi-k2-0905-preview' },
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

test('resolveAgentEnvFacts handles missing kimiConfig + non-string trustedRoot defensively', () => {
  const facts = resolveAgentEnvFacts({ trustedRoot: null, kimiConfig: null, platform: 'win32' });
  assert.equal(facts.trustedRoot, '');
  assert.equal(facts.osName, 'Windows');
  assert.equal(facts.provider, '');
  assert.equal(facts.model, '');
});
