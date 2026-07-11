import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildReleaseCommandSpec,
  FULL_SOURCE_GATE_TIMEOUT_MS,
} from '../../../scripts/release-command.js';

test('release outer source-gate timeout exceeds every nested full-gate step', () => {
  const longestNestedStepMs = 2_700_000;
  assert.ok(FULL_SOURCE_GATE_TIMEOUT_MS > longestNestedStepMs);
  assert.equal(FULL_SOURCE_GATE_TIMEOUT_MS, 7_200_000);
  const releaseSource = fs.readFileSync(
    path.resolve(process.cwd(), '../../scripts/release.ts'),
    'utf8',
  );
  assert.match(
    releaseSource,
    /quality_gate\.py'[\s\S]*?timeoutMs:\s*FULL_SOURCE_GATE_TIMEOUT_MS/,
  );
});

test('release pipeline validates its output directory through the shared real-path boundary', () => {
  const releaseSource = fs.readFileSync(
    path.resolve(process.cwd(), '../../scripts/release.ts'),
    'utf8',
  );
  assert.match(releaseSource, /releaseDir\s*=\s*resolveJailedOutputPath\(/);
  assert.match(
    releaseSource,
    /options\.execute\s*&&\s*fs\.existsSync\(releaseDir\)[\s\S]*?Refusing to overwrite an existing release directory/,
  );
});

test('release git probes are bounded and fail explicitly', () => {
  const releaseSource = fs.readFileSync(
    path.resolve(process.cwd(), '../../scripts/release.ts'),
    'utf8',
  );
  const gitCapture = /function gitCapture[\s\S]*?\n}\n\nfunction readGitHead/.exec(releaseSource)?.[0] || '';
  assert.match(gitCapture, /timeout:\s*30_000/);
  assert.match(gitCapture, /result\.error[\s\S]*?throw new Error/);
  assert.match(gitCapture, /result\.status !== 0[\s\S]*?throw new Error/);
});

test('Windows release commands preserve shell metacharacters without cmd.exe', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-release-command-'));
  try {
    const fakeNpmCli = path.join(root, 'npm cli fixture', 'npm-cli.js');
    fs.mkdirSync(path.dirname(fakeNpmCli), { recursive: true });
    fs.writeFileSync(
      fakeNpmCli,
      'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n',
      'utf8',
    );
    const specialArgs = [
      'run',
      'fixture',
      String.raw`C:\release fixtures\A&B^C%25\cert file.pfx`,
      'https://timestamp.example.test/path?first=1&second=2^3%25',
    ];

    const spec = buildReleaseCommandSpec('npm', specialArgs, {
      platform: 'win32',
      nodeExecPath: process.execPath,
      npmExecPath: fakeNpmCli,
    });

    assert.equal(spec.command, process.execPath);
    assert.deepEqual(spec.args, [fakeNpmCli, ...specialArgs]);
    assert.doesNotMatch(spec.command, /cmd(?:\.exe)?$/i);
    const result = spawnSync(spec.command, spec.args, { encoding: 'utf8', shell: false });
    const stderr = typeof result.stderr === 'string' ? result.stderr : result.stderr?.toString('utf8');
    const stdout = typeof result.stdout === 'string' ? result.stdout : result.stdout?.toString('utf8') || '';
    assert.equal(result.status, 0, stderr);
    assert.deepEqual(JSON.parse(stdout), specialArgs);

    const direct = buildReleaseCommandSpec('pwsh', specialArgs, { platform: 'win32' });
    assert.deepEqual(direct, { command: 'pwsh', args: specialArgs });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Windows npm invocation fails closed without a resolvable npm CLI', () => {
  assert.throws(
    () => buildReleaseCommandSpec('npm', ['run', 'build:ui'], {
      platform: 'win32',
      nodeExecPath: process.execPath,
      npmExecPath: null,
    }),
    /npm CLI entry point/i,
  );
});
