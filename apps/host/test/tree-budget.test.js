import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { listWorkspaceTree } from '../src/workspace/file-tree.js';
import { buildContextBundle } from '../src/workspace/context-bundle.js';
import { makeTestWorkspace } from './test-fixtures.js';

test('listWorkspaceTree respects maxEntries and maxDepth', () => {
  const root = makeTestWorkspace('kcw-tree');
  // wide: 30 files at top level
  for (let i = 0; i < 30; i += 1) fs.writeFileSync(path.join(root, `f${i}.txt`), 'x');
  // deep: a/b/c/d/deep.txt
  const deep = path.join(root, 'a', 'b', 'c', 'd');
  fs.mkdirSync(deep, { recursive: true });
  fs.writeFileSync(path.join(deep, 'deep.txt'), 'x');

  const capped = listWorkspaceTree(root, { maxEntries: 10 });
  assert.ok(capped.length <= 10, `maxEntries respected (got ${capped.length})`);

  const shallow = listWorkspaceTree(root, { maxDepth: 1 });
  // nothing deeper than depth 1 (so a/b/.. files are excluded)
  assert.ok(!shallow.some((e) => e.path.includes('a/b/c')), 'maxDepth excludes deep paths');
});

test('buildContextBundle respects a total byte budget', () => {
  const root = makeTestWorkspace('kcw-bundle');
  for (let i = 0; i < 20; i += 1) fs.writeFileSync(path.join(root, `b${i}.txt`), 'y'.repeat(2000));
  const bundle = buildContextBundle({ trustedRoot: root, paths: ['.'], maxTotalBytes: 5000, maxTextSize: 4000 });
  // 5000 byte budget / ~2000 each -> at most ~3 files included.
  assert.ok(bundle.files.length <= 4, `total budget respected (got ${bundle.files.length})`);
  assert.ok(bundle.skipped.some((s) => /budget/.test(s.reason)), 'over-budget files are marked skipped');
});
