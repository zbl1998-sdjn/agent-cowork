import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRuntimeDependencyUpdatePlan } from '../apps/host/src/runtime/dependency-install-plan.js';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(scriptDir);
const runRoot = path.join(repoRoot, 'build', 'runtime-update-preservation');
const appDataRoot = path.join(runRoot, 'AgentCowork');

function writeSentinel(relativePath, value) {
  const target = path.join(appDataRoot, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, value, 'utf8');
  return target;
}

fs.rmSync(runRoot, { recursive: true, force: true });
const sentinels = [
  writeSentinel(path.join('components', 'data-science', '.installed'), 'data-science'),
  writeSentinel(path.join('components', 'playwright-chromium', '.installed'), 'playwright'),
  writeSentinel(path.join('venv', 'pyvenv.cfg'), 'home = embedded-python'),
  writeSentinel('config.json', '{"preserve":true}'),
  writeSentinel('state.sqlite', 'sqlite-placeholder'),
  writeSentinel(path.join('cache', 'download.lock'), 'cache'),
];

const plan = buildRuntimeDependencyUpdatePlan({
  appDataRoot,
  currentVersion: '0.2.0',
  targetVersion: '0.2.1',
  selectedIds: ['data-science', 'playwright-chromium'],
});

assert.equal(plan.ok, true);
assert.equal(plan.mode, 'preserve-on-update');
assert.equal(plan.destructiveActions.length, 0);
assert.deepEqual(plan.components.map((item) => item.id), ['data-science', 'playwright-chromium']);
for (const item of [...plan.retained, ...plan.components]) {
  assert.equal(item.action, 'preserve');
  assert.ok(item.path === appDataRoot || item.path.startsWith(`${appDataRoot}${path.sep}`), `${item.path} escaped ${appDataRoot}`);
}
for (const file of sentinels) {
  assert.equal(fs.existsSync(file), true, `sentinel was not preserved: ${file}`);
}

const reportDir = path.join(repoRoot, 'reports', 'runtime-dependencies');
fs.mkdirSync(reportDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const reportPath = path.join(reportDir, `runtime-update-preservation-${stamp}.json`);
fs.writeFileSync(reportPath, `${JSON.stringify({
  ok: true,
  mode: 'preserve-on-update',
  generatedAt: new Date().toISOString(),
  appDataRoot,
  sentinels,
  plan,
}, null, 2)}\n`, 'utf8');

console.log(`Runtime update preservation smoke passed: ${reportPath}`);
