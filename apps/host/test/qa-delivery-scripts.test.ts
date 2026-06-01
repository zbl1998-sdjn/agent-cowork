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
  assert.equal(packageJson.scripts['smoke:e2e'], hostNode('scripts/e2e-smoke.ts'));
  assert.equal(packageJson.scripts['smoke:ui'], hostNode('scripts/smoke-ui-contract.ts'));
  assert.equal(packageJson.scripts['smoke:windows-paths'], hostNode('scripts/smoke-windows-paths.ts'));
  assert.equal(packageJson.scripts['demo:mvp'], hostNode('scripts/demo-mvp.ts'));
  assert.equal(packageJson.scripts['verify:mvp'], hostNode('scripts/verify-mvp.ts'));
  assert.equal(packageJson.scripts.bench, hostNode('scripts/bench.ts'));
  assert.equal(packageJson.scripts['smoke:kimi-api'], hostNode('scripts/smoke-kimi-api.ts'));
  assert.equal(packageJson.scripts['check:secrets'], hostNode('scripts/check-secrets.ts'));
  const windowsClientSmokeScript = packageJson.scripts['smoke:windows-client'];
  assert.ok(windowsClientSmokeScript);
  assert.match(windowsClientSmokeScript, /smoke-windows-client\.ps1/);

  const deliveryScripts = [
    'scripts/e2e-smoke.ts',
    'scripts/smoke-ui-contract.ts',
    'scripts/smoke-windows-paths.ts',
    'scripts/demo-mvp.ts',
    'scripts/verify-mvp.ts',
    'scripts/bench.ts',
    'scripts/check-secrets.ts',
    'scripts/smoke-kimi-api.ts',
  ] as const;
  for (const script of deliveryScripts) {
    assert.ok(fs.existsSync(path.join(repoRoot, script)), `${script} is missing`);
  }

  const kimiSmoke = fs.readFileSync(path.join(repoRoot, 'scripts/smoke-kimi-api.ts'), 'utf8');
  assert.match(kimiSmoke, /\/api\/auth\/guest/);
  assert.match(kimiSmoke, /Bearer \$\{guest\.token\}/);

  const windowsSmoke = fs.readFileSync(path.join(repoRoot, 'scripts/smoke-windows-client.ps1'), 'utf8');
  assert.match(windowsSmoke, /\[string\]\$ReportPath/);
  assert.match(windowsSmoke, /reports\\windows-client-smoke/);

  const verifyMvp = fs.readFileSync(path.join(repoRoot, 'scripts/verify-mvp.ts'), 'utf8');
  assert.match(verifyMvp, /run-host-node\.mjs/);
  assert.match(verifyMvp, /demo-mvp\.ts/);
  assert.match(verifyMvp, /hostScriptArgs\('smoke-mvp-runtime\.ts'\)/);

  const mvpRuntimeSmoke = fs.readFileSync(path.join(repoRoot, 'scripts/smoke-mvp-runtime.ts'), 'utf8');
  assert.match(mvpRuntimeSmoke, /run-host-node\.mjs/);
  assert.match(mvpRuntimeSmoke, /isPidAlive\(runtime\.pid\)/);
});
