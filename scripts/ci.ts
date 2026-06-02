// CI 门禁执行入口:按序运行各门禁步骤,任一失败即阻断(scripts · 门禁(gate))
// ---------------------------------------------------------------------------
// 职责:从 ci-gates 取得本次应跑的步骤列表(含按变更触发的 eval),依次以子进程
//   运行 `npm run <step>`(Windows 下经 cmd /c 调用),实时透传输出与耗时;
//   任一步骤退出码非 0 即打印失败信息并以该退出码 exit,阻断后续步骤。
// 用法:npm run ci(即 node scripts/run-host-node.mjs scripts/ci.ts);
//   也被 release.ts 在非 --skip-ci 时前置调用、被 verify-mvp.ts 作为静态/单测门禁项调用。
// 依赖:./ci-gates(步骤编排)、各 npm 脚本 check / test:host / test:ui / eval。

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCiSteps, changedFilesFromEnv } from './ci-gates.js';
import type { CiStep } from './ci-gates.js';

type StepResult = {
  code: number;
  signal: string | null;
};

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const npmCommand = 'npm';
const steps = buildCiSteps({
  changedFiles: changedFilesFromEnv(),
  forceEval: process.env.KCW_CI_FORCE_EVAL === '1',
});

function runStep(step: CiStep): Promise<StepResult> {
  return new Promise((resolve) => {
    console.log(`\n[ci] ${step.name}: npm ${step.args.join(' ')}`);
    const command = process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : npmCommand;
    const args =
      process.platform === 'win32'
        ? ['/d', '/s', '/c', [npmCommand, ...step.args].join(' ')]
        : step.args;
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: process.env,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.on('close', (code, signal) => {
      resolve({ code: code ?? 1, signal });
    });
    child.on('error', (error) => {
      console.error(`[ci] failed to start ${step.name}: ${error.message}`);
      resolve({ code: 1, signal: null });
    });
  });
}

for (const step of steps) {
  const startedAt = Date.now();
  const result = await runStep(step);
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  if (result.code !== 0) {
    console.error(`[ci] ${step.name} failed after ${seconds}s with exit code ${result.code}`);
    if (result.signal) {
      console.error(`[ci] terminated by signal ${result.signal}`);
    }
    process.exit(result.code);
  }
  console.log(`[ci] ${step.name} passed in ${seconds}s`);
}

console.log('\n[ci] all gates passed');
