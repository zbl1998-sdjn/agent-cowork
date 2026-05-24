import assert from 'node:assert/strict';
import test from 'node:test';

import { scanTextForSecrets, shouldSkipWalkFallback } from '../../../scripts/check-secrets.mjs';

test('secret scan detects high-confidence secrets without echoing the value', () => {
  const token = 'sk-live-abcdefghijklmnopqrstuvwxyz1234567890';
  const findings = scanTextForSecrets(`MOONSHOT_API_KEY=${token}\n`, 'scripts/prod-config.md');

  assert.ok(findings.length >= 1);
  assert.equal(findings[0].path, 'scripts/prod-config.md');
  assert.equal(findings[0].line, 1);
  assert.ok(!findings.some((finding) => finding.excerpt.includes(token)), 'finding excerpt must not leak the token');
});

test('secret scan ignores test fixtures and placeholder values', () => {
  assert.deepEqual(
    scanTextForSecrets('const key = "sk-live-abcdefghijklmnopqrstuvwxyz1234567890";', 'apps/host/test/fake.test.js'),
    [],
  );
  assert.deepEqual(
    scanTextForSecrets('api_key=your_key_here_placeholder_value_123456', 'docs/setup.md'),
    [],
  );
});

test('secret scan detects private key blocks in repo documents', () => {
  const text = [
    '-----BEGIN PRIVATE KEY-----',
    'abc',
    '-----END PRIVATE KEY-----',
  ].join('\n');
  const findings = scanTextForSecrets(text, 'docs/keys.md');

  assert.equal(findings.length, 1);
  assert.equal(findings[0].detector, 'private-key');
});

test('secret scan fallback walk skips local ignored env and fuse temp files', () => {
  assert.equal(shouldSkipWalkFallback('.env'), true);
  assert.equal(shouldSkipWalkFallback('.env.local'), true);
  assert.equal(shouldSkipWalkFallback('apps/host/src/artifacts/.fuse_hidden0000000e00000001'), true);
  assert.equal(shouldSkipWalkFallback('docs/env-example.md'), false);
});
