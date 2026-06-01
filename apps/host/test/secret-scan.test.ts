import assert from 'node:assert/strict';
import test from 'node:test';

type SecretFinding = {
  path: string;
  line: number;
  excerpt: string;
  detector?: string;
};

type SecretScanModule = {
  scanTextForSecrets(text: string, filePath: string): SecretFinding[];
  shouldSkipWalkFallback(filePath: string): boolean;
};
const checkSecretsScript = '../../../scripts/check-secrets.mjs';

async function loadSecretScan(): Promise<SecretScanModule> {
  return await import(checkSecretsScript) as SecretScanModule;
}

test('secret scan detects high-confidence secrets without echoing the value', async () => {
  const { scanTextForSecrets } = await loadSecretScan();
  const token = 'sk-live-abcdefghijklmnopqrstuvwxyz1234567890';
  const findings = scanTextForSecrets(`MOONSHOT_API_KEY=${token}\n`, 'scripts/prod-config.md');
  const firstFinding = findings[0];

  assert.ok(findings.length >= 1);
  assert.ok(firstFinding);
  assert.equal(firstFinding.path, 'scripts/prod-config.md');
  assert.equal(firstFinding.line, 1);
  assert.ok(!findings.some((finding) => finding.excerpt.includes(token)), 'finding excerpt must not leak the token');
});

test('secret scan ignores test fixtures and placeholder values', async () => {
  const { scanTextForSecrets } = await loadSecretScan();
  assert.deepEqual(
    scanTextForSecrets('const key = "sk-live-abcdefghijklmnopqrstuvwxyz1234567890";', 'apps/host/test/fake.test.js'),
    [],
  );
  assert.deepEqual(
    scanTextForSecrets('api_key=your_key_here_placeholder_value_123456', 'docs/setup.md'),
    [],
  );
});

test('secret scan detects private key blocks in repo documents', async () => {
  const { scanTextForSecrets } = await loadSecretScan();
  const text = [
    '-----BEGIN PRIVATE KEY-----',
    'abc',
    '-----END PRIVATE KEY-----',
  ].join('\n');
  const findings = scanTextForSecrets(text, 'docs/keys.md');
  const firstFinding = findings[0];

  assert.equal(findings.length, 1);
  assert.ok(firstFinding);
  assert.equal(firstFinding.detector, 'private-key');
});

test('secret scan fallback walk skips local ignored env and fuse temp files', async () => {
  const { shouldSkipWalkFallback } = await loadSecretScan();
  assert.equal(shouldSkipWalkFallback('.env'), true);
  assert.equal(shouldSkipWalkFallback('.env.local'), true);
  assert.equal(shouldSkipWalkFallback('apps/host/src/artifacts/.fuse_hidden0000000e00000001'), true);
  assert.equal(shouldSkipWalkFallback('docs/env-example.md'), false);
});
