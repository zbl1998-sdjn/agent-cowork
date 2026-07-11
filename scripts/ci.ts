// CI 门禁执行入口:同组有界并行、跨组按序运行,任一失败即阻断(scripts · 门禁(gate))
// ---------------------------------------------------------------------------
// 职责:从 ci-gates 取得本次应跑的步骤列表(含按变更触发的 eval),同一 parallelGroup
//   以受限 worker 运行 `npm run <step>`(Windows 下经 cmd /c 调用),实时透传输出与耗时;
//   聚合组内失败后以非零码退出,并阻断后续步骤组。
// 用法:npm run ci(即 node scripts/run-host-node.mjs scripts/ci.ts);
//   也被 release.ts 在非 --skip-ci 时前置调用、被 verify-mvp.ts 作为静态/单测门禁项调用。
// 依赖:./ci-gates(步骤编排)、各 npm 脚本 check / test:host:coverage:90 / test:ui / eval。

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCiSteps, changedFilesFromEnv, ciStepEnvironment } from './ci-gates.js';
import type { CiStep } from './ci-gates.js';
import { runCiProcess } from './ci-process.js';
import { CiStepFailure, ciConcurrency, runCiSteps } from './ci-runner.js';
import type { StepResult } from './ci-runner.js';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const npmCommand = 'npm';
const steps = buildCiSteps({
  changedFiles: changedFilesFromEnv(),
  forceEval: process.env.KCW_CI_FORCE_EVAL === '1',
});

function runStep(step: CiStep): Promise<StepResult> {
  console.log(`\n[ci] ${step.name}: npm ${step.args.join(' ')}`);
  const command = process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : npmCommand;
  const args =
    process.platform === 'win32'
      ? ['/d', '/s', '/c', [npmCommand, ...step.args].join(' ')]
      : [...step.args];
  return runCiProcess({
    stepName: step.name,
    command,
    args,
    cwd: repoRoot,
    env: ciStepEnvironment(step),
    timeoutMs: step.timeoutMs,
    stdio: 'inherit',
  });
}

async function runStepWithEvidence(step: CiStep): Promise<StepResult> {
  const startedAt = Date.now();
  const result = await runStep(step);
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  if (result.code !== 0) {
    console.error(`[ci] ${step.name} failed after ${seconds}s with exit code ${result.code}`);
    if (result.error) console.error(`[ci] ${result.error}`);
    if (result.signal) {
      console.error(`[ci] terminated by signal ${result.signal}`);
    }
    return result;
  }
  console.log(`[ci] ${step.name} passed in ${seconds}s`);
  return result;
}

try {
  const concurrency = ciConcurrency();
  console.log(`[ci] bounded source-gate concurrency: ${concurrency}`);
  await runCiSteps(steps, { concurrency, runStep: runStepWithEvidence });
  console.log('\n[ci] all gates passed');
} catch (error) {
  if (error instanceof CiStepFailure) {
    console.error(`[ci] ${error.message}`);
    process.exitCode = error.exitCode;
  } else {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[ci] runner failed: ${message}`);
    process.exitCode = 1;
  }
}
