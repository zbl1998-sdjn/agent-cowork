import os from 'node:os';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { runCommand } from '../src/workspace/command-runner.js';

const workspace = path.join(os.tmpdir(), 'kfcowork-commands');
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
