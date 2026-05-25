import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCiSteps, changedFilesFromEnv } from './ci-gates.mjs';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const npmCommand = 'npm';
const steps = buildCiSteps({
  changedFiles: changedFilesFromEnv(),
  forceEval: process.env.KCW_CI_FORCE_EVAL === '1',
});

function runStep(step) {
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
