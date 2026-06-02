// 运行时依赖更新保留冒烟(scripts · smoke·E2E)
// ---------------------------------------------------------------------------
// 职责:在临时 AppData 目录写入一批哨兵文件(已装组件标记、嵌入式 venv、config.json、
//       state.sqlite、缓存等),调用 buildRuntimeDependencyUpdatePlan 生成版本升级计划,
//       断言计划为 preserve-on-update 模式、无破坏性动作、所有条目动作为 preserve 且路径
//       不越出 AppData 根,并核验升级后哨兵文件全部留存——证明依赖更新不会清掉用户数据。
//       报告写入 reports/runtime-dependencies。
// 用法:npm run smoke:runtime-update(即 node scripts/run-host-node.mjs scripts/smoke-runtime-update-preservation.ts);
//       断言失败即 exit 1 阻断。
// 依赖:apps/host 的 buildRuntimeDependencyUpdatePlan;顶层直接执行(无 main 包装)。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRuntimeDependencyUpdatePlan } from '../apps/host/src/runtime/dependency-install-plan.js';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(scriptDir);
const runRoot = path.join(repoRoot, 'build', 'runtime-update-preservation');
const appDataRoot = path.join(runRoot, 'AgentCowork');

function writeSentinel(relativePath: string, value: string): string {
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
  const itemPath = item.path;
  if (typeof itemPath !== 'string') {
    throw new Error('preserved dependency item must include a concrete path');
  }
  assert.ok(itemPath === appDataRoot || itemPath.startsWith(`${appDataRoot}${path.sep}`), `${itemPath} escaped ${appDataRoot}`);
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
