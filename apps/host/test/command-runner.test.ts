import { mkdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { runCommand } from '../src/workspace/command-runner.js';
import { makeTestWorkspace } from './test-fixtures.js';

const workspace = makeTestWorkspace('kfcowork-commands');
mkdirSync(workspace, { recursive: true });

test('command runner is disabled unless allowCommands is true', async () => {
  await assert.rejects(
    () => runCommand({
      command: 'node',
      cwd: workspace,
      trustedRoot: workspace,
      allowCommands: false,
    }),
    /disabled/i,
  );
});

test('command runner requires a trusted root and a command', async () => {
  await assert.rejects(
    () => runCommand({
      command: process.execPath,
      cwd: workspace,
      allowCommands: true,
    }),
    /trustedRoot is required/,
  );
  await assert.rejects(
    () => runCommand({
      cwd: workspace,
      trustedRoot: workspace,
      allowCommands: true,
    }),
    /command is required/,
  );
});

test('command runner jails cwd to trustedRoot before spawning', async () => {
  await assert.rejects(
    () => runCommand({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("should-not-run")'],
      cwd: path.dirname(workspace),
      trustedRoot: workspace,
      allowCommands: true,
    }),
    /Path escaped trusted root/,
  );
});

test('command runner uses argv without shell interpretation', async () => {
  const result = await runCommand({
    command: process.execPath,
    args: ['-e', 'process.stdout.write(process.argv[1])', 'hello && echo escaped'],
    cwd: workspace,
    trustedRoot: workspace,
    allowCommands: true,
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, 'hello && echo escaped');
  assert.equal(result.stderr, '');
  assert.equal(result.timedOut, false);
  assert.equal(result.truncated, false);
});

test('command runner caps stdout and stderr while preserving exit code', async () => {
  const result = await runCommand({
    command: process.execPath,
    args: ['-e', 'process.stdout.write("abcdef"); process.stderr.write("vwxyz"); process.exit(7)'],
    cwd: workspace,
    trustedRoot: workspace,
    allowCommands: true,
    maxOutputBytes: 3,
  });

  assert.equal(result.exitCode, 7);
  assert.equal(result.stdout, 'abc');
  assert.equal(result.stderr, 'vwx');
  assert.equal(result.timedOut, false);
  assert.equal(result.truncated, true);
});

test('command runner reports timeout as a structured command result', async () => {
  const result = await runCommand({
    command: process.execPath,
    args: ['-e', 'setTimeout(() => {}, 10000)'],
    cwd: workspace,
    trustedRoot: workspace,
    allowCommands: true,
    timeoutMs: 50,
  });

  assert.equal(result.exitCode, -1);
  assert.equal(result.timedOut, true);
  assert.equal(result.truncated, true);
  assert.match(result.error || '', /timed out after 50ms/);
});
