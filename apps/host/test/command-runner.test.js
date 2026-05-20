import { mkdirSync } from 'node:fs';
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { runCommand } from '../src/workspace/command-runner.js';
import { makeTestWorkspace } from './test-fixtures.js';

const workspace = makeTestWorkspace('kfcowork-commands');
mkdirSync(workspace, { recursive: true });

test('command runner is disabled unless allowCommands is true', async () => {
  await assert.rejects(
    runCommand({
      command: 'node',
      cwd: workspace,
      trustedRoot: workspace,
      allowCommands: false,
    }),
    /disabled/i,
  );
});
