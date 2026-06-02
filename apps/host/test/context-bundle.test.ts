import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildContextBundle } from '../src/workspace/context-bundle.js';
import { makeTestWorkspace } from './test-fixtures.js';

const root = makeTestWorkspace('kfcowork-bundle');
const normal = path.join(root, 'report.txt');
const sensitive = path.join(root, '.env');

fs.writeFileSync(normal, 'normal content', 'utf8');
fs.writeFileSync(sensitive, 'secret=1', 'utf8');

test('skips sensitive files when building context bundle', () => {
  const bundle = buildContextBundle({
    root,
    paths: [normal, sensitive],
    maxTextSize: 1024,
  });

  assert.equal(bundle.files.length, 1);
  const firstFile = bundle.files[0];
  assert.ok(firstFile);
  assert.equal(firstFile.path, normal);
  assert.equal(bundle.skipped.length, 1);
  const firstSkipped = bundle.skipped[0];
  assert.ok(firstSkipped);
  assert.equal(firstSkipped.path, sensitive);
});
