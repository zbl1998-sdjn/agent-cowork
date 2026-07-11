import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createOfflineReplayExecutor } from '../../../eval/replay-backend.js';
import { runEvalTasks } from '../../../eval/runner.js';
import { loadAllEvalTasks } from '../../../eval/tasks/index.js';
import { readReplayRecords } from '../../../scripts/eval.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const fixturePath = path.join(repoRoot, 'eval', 'fixtures', 'ci-model-records.json');

test('version-controlled CI replay fixture covers every eval task and passes real scorers', async () => {
  assert.equal(fs.existsSync(fixturePath), true, 'CI replay fixture must be version controlled');
  const records = readReplayRecords(fixturePath);
  assert.ok(records && records.length > 0);

  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-ci-eval-fixture-'));
  try {
    const summary = await runEvalTasks({
      tasks: loadAllEvalTasks(),
      workRoot,
      executor: createOfflineReplayExecutor({ records }),
    });
    assert.equal(summary.failedTasks, 0);
    assert.equal(summary.passRate, 1);
    assert.ok(summary.totalTasks >= 20);
  } finally {
    fs.rmSync(workRoot, { recursive: true, force: true });
  }
});
