import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createBenchmarkWorkspace,
  removeBenchmarkWorkspace,
} from '../../../scripts/bench-workspace.js';

test('benchmark workspace cleanup removes only its jailed temporary child', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-bench-parent-'));
  try {
    const workspace = createBenchmarkWorkspace(parent);
    fs.writeFileSync(path.join(workspace.root, 'state.txt'), 'temporary', 'utf8');

    removeBenchmarkWorkspace(workspace);
    assert.equal(fs.existsSync(workspace.root), false);
    assert.equal(fs.existsSync(parent), true);

    assert.throws(
      () => removeBenchmarkWorkspace({ base: parent, root: parent }),
      /refusing benchmark workspace cleanup/i,
    );
    assert.throws(
      () => removeBenchmarkWorkspace({ base: parent, root: path.join(parent, 'unrelated') }),
      /refusing benchmark workspace cleanup/i,
    );
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
