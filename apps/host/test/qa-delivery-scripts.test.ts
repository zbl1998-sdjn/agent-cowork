import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const hostNode = (scriptPath: string): string => `node scripts/run-host-node.mjs ${scriptPath}`;
type PackageJson = { scripts: Record<string, string> };

test('Q6/Q7/R5 delivery scripts are registered and parseable', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as PackageJson;
  assert.equal(packageJson.scripts['smoke:e2e'], hostNode('scripts/e2e-smoke.mjs'));
  assert.equal(packageJson.scripts.bench, hostNode('scripts/bench.mjs'));
  assert.equal(packageJson.scripts['smoke:kimi-api'], hostNode('scripts/smoke-kimi-api.mjs'));
  assert.equal(packageJson.scripts['check:secrets'], 'node scripts/check-secrets.mjs');
  const windowsClientSmokeScript = packageJson.scripts['smoke:windows-client'];
  assert.ok(windowsClientSmokeScript);
  assert.match(windowsClientSmokeScript, /smoke-windows-client\.ps1/);

  const deliveryScripts = [
    'scripts/e2e-smoke.mjs',
    'scripts/bench.mjs',
    'scripts/check-secrets.mjs',
    'scripts/smoke-kimi-api.mjs',
  ] as const;
  for (const script of deliveryScripts) {
    assert.ok(fs.existsSync(path.join(repoRoot, script)), `${script} is missing`);
  }

  const kimiSmoke = fs.readFileSync(path.join(repoRoot, 'scripts/smoke-kimi-api.mjs'), 'utf8');
  assert.match(kimiSmoke, /\/api\/auth\/guest/);
  assert.match(kimiSmoke, /Bearer \$\{guest\.token\}/);

  const windowsSmoke = fs.readFileSync(path.join(repoRoot, 'scripts/smoke-windows-client.ps1'), 'utf8');
  assert.match(windowsSmoke, /\[string\]\$ReportPath/);
  assert.match(windowsSmoke, /reports\\windows-client-smoke/);

  const verifyMvp = fs.readFileSync(path.join(repoRoot, 'scripts/verify-mvp.mjs'), 'utf8');
  assert.match(verifyMvp, /run-host-node\.mjs/);
  assert.match(verifyMvp, /hostScriptArgs\('smoke-mvp-runtime\.mjs'\)/);

  const mvpRuntimeSmoke = fs.readFileSync(path.join(repoRoot, 'scripts/smoke-mvp-runtime.mjs'), 'utf8');
  assert.match(mvpRuntimeSmoke, /run-host-node\.mjs/);
  assert.match(mvpRuntimeSmoke, /isPidAlive\(runtime\.pid\)/);
});
