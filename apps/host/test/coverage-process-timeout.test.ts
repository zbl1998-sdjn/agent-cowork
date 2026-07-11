import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  HOST_COVERAGE_TIMEOUT_MS,
  runCoverageProcess,
} from '../../../scripts/coverage-process.js';
import { formatCoverageEvidenceCommand } from '../../../scripts/coverage-policy.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function stringEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH') {
      return false;
    }
    throw error;
  }
}

test('coverage process timeout captures diagnostics and terminates the full child tree', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-coverage-timeout-'));
  const startedMarker = path.join(root, 'grandchild-started.txt');
  const pidMarker = path.join(root, 'grandchild-pid.txt');
  const escapedMarker = path.join(root, 'grandchild-escaped.txt');
  const grandchildScript = [
    `require('node:fs').writeFileSync(${JSON.stringify(startedMarker)}, 'started');`,
    `require('node:fs').writeFileSync(${JSON.stringify(pidMarker)}, String(process.pid));`,
    "process.stdout.write('grandchild-ready\\n');",
    "process.stderr.write('grandchild-stderr\\n');",
    `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(escapedMarker)}, 'escaped'), 4000);`,
    'setInterval(() => {}, 1000);',
  ].join('');
  const parentScript = [
    `require('node:child_process').spawn(${JSON.stringify(process.execPath)}, `,
    `['-e', ${JSON.stringify(grandchildScript)}], { stdio: 'inherit' });`,
    'setInterval(() => {}, 1000);',
  ].join('');
  const startedAt = Date.now();

  const result = await runCoverageProcess({
    command: process.execPath,
    args: ['-e', parentScript],
    cwd: process.cwd(),
    env: stringEnvironment(),
    timeoutMs: 800,
  });

  assert.equal(result.status, null);
  assert.equal(result.timedOut, true);
  assert.match(result.error?.message || '', /coverage process timed out after 800ms/i);
  assert.match(result.stdout, /grandchild-ready/);
  assert.match(result.stderr, /grandchild-stderr/);
  assert.ok(Date.now() - startedAt < 8000, 'timed-out coverage process should return promptly');
  assert.equal(fs.existsSync(startedMarker), true, 'the grandchild must have started before timeout');
  const grandchildPid = Number(fs.readFileSync(pidMarker, 'utf8'));
  assert.equal(processExists(grandchildPid), false, 'tree cleanup must finish before the runner returns');

  await new Promise((resolve) => setTimeout(resolve, 4200));
  assert.equal(fs.existsSync(escapedMarker), false, 'the timed-out process tree must not survive');
});

test('coverage process returns captured output for a successful bounded command', async () => {
  const result = await runCoverageProcess({
    command: process.execPath,
    args: ['-e', "process.stdout.write('coverage-ok'); process.stderr.write('coverage-note');"],
    cwd: process.cwd(),
    env: stringEnvironment(),
    timeoutMs: 5000,
  });

  assert.equal(result.status, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.error, undefined);
  assert.equal(result.stdout, 'coverage-ok');
  assert.equal(result.stderr, 'coverage-note');
});

test('host coverage entrypoint uses the bounded process runner with outer-gate headroom', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'scripts', 'run-host-coverage.ts'), 'utf8');
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
  assert.match(source, /runCoverageProcess\(\{/);
  assert.match(source, /timeoutMs: HOST_COVERAGE_TIMEOUT_MS/);
  assert.match(source, /'--test-concurrency=8'/);
  assert.match(packageJson.scripts?.['test:host'] || '', /--test-concurrency=8/);
  assert.doesNotMatch(source, /spawnSync/);
  assert.equal(HOST_COVERAGE_TIMEOUT_MS, 1_680_000);
  assert.ok(HOST_COVERAGE_TIMEOUT_MS < 1_800_000);
});

test('coverage evidence command replaces the local loader path with a portable repo marker', () => {
  const loaderUrl = 'file:///C:/Users/example/private-worktree/scripts/run-host-node.mjs?register-only=1';
  const command = formatCoverageEvidenceCommand(
    ['--import', loaderUrl, '--test', 'test/*.test.ts'],
    loaderUrl,
  );

  assert.equal(
    command,
    'node --import file:///<repo>/scripts/run-host-node.mjs?register-only=1 --test test/*.test.ts',
  );
  assert.doesNotMatch(command, /C:\/Users\/example/);
});
