import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

test('Q6/Q7/R5 delivery scripts are registered and parseable', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  assert.equal(packageJson.scripts['smoke:e2e'], 'node scripts/e2e-smoke.mjs');
  assert.equal(packageJson.scripts.bench, 'node scripts/bench.mjs');
  assert.equal(packageJson.scripts['check:secrets'], 'node scripts/check-secrets.mjs');
  assert.match(packageJson.scripts['smoke:windows-client'], /smoke-windows-client\.ps1/);

  for (const script of ['scripts/e2e-smoke.mjs', 'scripts/bench.mjs', 'scripts/check-secrets.mjs']) {
    assert.ok(fs.existsSync(path.join(repoRoot, script)), `${script} is missing`);
  }

  const windowsSmoke = fs.readFileSync(path.join(repoRoot, 'scripts/smoke-windows-client.ps1'), 'utf8');
  assert.match(windowsSmoke, /\[string\]\$ReportPath/);
  assert.match(windowsSmoke, /reports\\windows-client-smoke/);
});
