import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { CiStep } from '../../../scripts/ci-gates.js';
import {
  CiStepFailure,
  ciConcurrency,
  runCiSteps,
  type StepResult,
} from '../../../scripts/ci-runner.js';

function step(name: string, parallelGroup?: string): CiStep {
  const base = { name, args: ['run', name], timeoutMs: 1000 };
  return parallelGroup ? { ...base, parallelGroup } : base;
}

type CiProcessModule = {
  CI_TREE_KILL_TIMEOUT_MS: number;
  runCiProcess(options: {
    stepName: string;
    command: string;
    args: string[];
    cwd: string;
    env: Record<string, string>;
    timeoutMs: number;
    stdio: 'inherit' | 'ignore';
  }): Promise<StepResult>;
};

async function loadCiProcess(): Promise<CiProcessModule> {
  return await import('../../../scripts/ci-process.js') as CiProcessModule;
}

function stringEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

test('CI runner bounds a contiguous parallel group and preserves the following serial boundary', async () => {
  const steps = [
    step('source-1', 'source'),
    step('source-2', 'source'),
    step('source-3', 'source'),
    step('source-4', 'source'),
    step('after'),
  ];
  let active = 0;
  let maxActive = 0;
  const started: string[] = [];
  const runStep = async (current: CiStep): Promise<StepResult> => {
    started.push(current.name);
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active -= 1;
    return { code: 0, signal: null };
  };

  await runCiSteps(steps, { concurrency: 2, runStep });

  assert.equal(maxActive, 2);
  assert.deepEqual([...started.slice(0, 4)].sort(), ['source-1', 'source-2', 'source-3', 'source-4']);
  assert.equal(started.at(-1), 'after');
});

test('CI runner fails closed after finishing the bounded group and does not enter the next group', async () => {
  const steps = [step('good', 'source'), step('bad', 'source'), step('must-not-run')];
  const started: string[] = [];

  await assert.rejects(
    () => runCiSteps(steps, {
      concurrency: 2,
      runStep: async (current) => {
        started.push(current.name);
        return { code: current.name === 'bad' ? 7 : 0, signal: null };
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof CiStepFailure);
      assert.equal(error.exitCode, 7);
      assert.match(error.message, /bad/);
      return true;
    },
  );
  assert.deepEqual([...started].sort(), ['bad', 'good']);
});

test('CI concurrency defaults to two and rejects unsafe values', () => {
  assert.equal(ciConcurrency({}), 2);
  assert.equal(ciConcurrency({ KCW_CI_CONCURRENCY: '4' }), 4);
  assert.throws(() => ciConcurrency({ KCW_CI_CONCURRENCY: '0' }), /KCW_CI_CONCURRENCY/);
  assert.throws(() => ciConcurrency({ KCW_CI_CONCURRENCY: 'many' }), /KCW_CI_CONCURRENCY/);
});

test('CI process timeout kills the full child tree and names the step and timeout', async () => {
  const { CI_TREE_KILL_TIMEOUT_MS, runCiProcess } = await loadCiProcess();
  assert.equal(CI_TREE_KILL_TIMEOUT_MS, 5_000);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-ci-timeout-'));
  const startedMarker = path.join(root, 'grandchild-started.txt');
  const escapedMarker = path.join(root, 'grandchild-escaped.txt');
  const grandchildScript = [
    `require('node:fs').writeFileSync(${JSON.stringify(startedMarker)}, 'started');`,
    `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(escapedMarker)}, 'escaped'), 4000);`,
  ].join('');
  const parentScript = [
    `require('node:child_process').spawn(${JSON.stringify(process.execPath)}, `,
    `['-e', ${JSON.stringify(grandchildScript)}], { stdio: 'ignore' });`,
    'setInterval(() => {}, 1000);',
  ].join('');
  const startedAt = Date.now();

  const result = await runCiProcess({
    stepName: 'hung-source-gate',
    command: process.execPath,
    args: ['-e', parentScript],
    cwd: process.cwd(),
    env: stringEnv(),
    timeoutMs: 800,
    stdio: 'ignore',
  });

  assert.equal(result.code, 1);
  assert.match(result.error || '', /hung-source-gate.*800ms/i);
  assert.ok(Date.now() - startedAt < 8000, 'timed-out CI step should return promptly');
  assert.equal(fs.existsSync(startedMarker), true, 'the grandchild must have started before timeout');
  await new Promise((resolve) => setTimeout(resolve, 4200));
  assert.equal(fs.existsSync(escapedMarker), false, 'the timed-out process tree must not survive');
});
