import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

type SecretFinding = {
  path: string;
  line: number;
  excerpt: string;
  detector?: string;
};

type SecretScanModule = {
  scanRepoForSecrets(files?: string[]): SecretFinding[];
  scanTextForSecrets(text: string, filePath: string): SecretFinding[];
  shouldSkipWalkFallback(filePath: string): boolean;
};
const checkSecretsScript = '../../../scripts/check-secrets.ts';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

async function loadSecretScan(): Promise<SecretScanModule> {
  return await import(checkSecretsScript) as SecretScanModule;
}

test('secret scan detects high-confidence secrets without echoing the value', async () => {
  const { scanTextForSecrets } = await loadSecretScan();
  const token = ['sk-live-', 'abcdefghijklmnopqrstuvwxyz1234567890'].join('');
  const findings = scanTextForSecrets(`MOONSHOT_API_KEY=${token}\n`, 'scripts/prod-config.md');
  const firstFinding = findings[0];

  assert.ok(findings.length >= 1);
  assert.ok(firstFinding);
  assert.equal(firstFinding.path, 'scripts/prod-config.md');
  assert.equal(firstFinding.line, 1);
  assert.ok(!findings.some((finding) => finding.excerpt.includes(token)), 'finding excerpt must not leak the token');
});

test('secret scan covers tests and reports while ignoring placeholders and build trees', async () => {
  const { scanTextForSecrets } = await loadSecretScan();
  const token = ['sk-live-', 'abcdefghijklmnopqrstuvwxyz1234567890'].join('');
  assert.equal(
    scanTextForSecrets(`const key = "${token}";`, 'apps/host/test/credential.test.js').length,
    1,
  );
  assert.equal(
    scanTextForSecrets(`{"apiKey":"${token}"}`, 'reports/security/audit.json').length,
    1,
  );
  assert.equal(
    scanTextForSecrets(`{"apiKey":"${token}"}`, 'reports/coverage/host-coverage-summary.json').length,
    1,
  );
  assert.deepEqual(
    scanTextForSecrets('api_key=your_key_here_placeholder_value_123456', 'docs/setup.md'),
    [],
  );
  assert.deepEqual(
    scanTextForSecrets(`const key = "${token}";`, 'apps/host/node_modules/example/index.js'),
    [],
  );
  assert.deepEqual(
    scanTextForSecrets(`const key = "${token}";`, 'apps/windows-client/src-tauri/target/release/example.js'),
    [],
  );
  assert.deepEqual(
    scanTextForSecrets(
      `{"apiKey":"${token}"}`,
      'reports/coverage/host-v8-2026-01-01/coverage-1.json',
    ),
    [],
  );
});

test('secret scan does not silently skip a large text report', async () => {
  const { scanRepoForSecrets } = await loadSecretScan();
  const relative = `reports/security/.secret-scan-large-${process.pid}.txt`;
  const full = path.join(repoRoot, relative);
  const token = ['sk-live-', 'abcdefghijklmnopqrstuvwxyz1234567890'].join('');
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, `${'x'.repeat(600 * 1024)}\n${token}\n`, 'utf8');
  try {
    const findings = scanRepoForSecrets([relative]);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.path, relative);
  } finally {
    fs.rmSync(full, { force: true });
  }
});

test('secret scan detects private key blocks in repo documents', async () => {
  const { scanTextForSecrets } = await loadSecretScan();
  const text = [
    ['-----BEGIN ', 'PRIVATE KEY-----'].join(''),
    'abc',
    ['-----END ', 'PRIVATE KEY-----'].join(''),
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
