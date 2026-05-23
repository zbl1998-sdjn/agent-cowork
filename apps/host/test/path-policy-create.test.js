import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertTrustedPath, assertTrustedPathForCreate } from '../src/security/path-policy.js';
import { makeTestWorkspace } from './test-fixtures.js';

test('create-aware check blocks junction/symlink escape for NEW files', () => {
  const root = makeTestWorkspace('kcw-pp-root');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-pp-outside-'));
  const link = path.join(root, 'link');
  // 'junction' works on Windows without admin; falls back to a symlink on POSIX.
  try {
    fs.symlinkSync(outside, link, 'junction');
  } catch {
    fs.symlinkSync(outside, link);
  }
  const escaped = path.join(link, 'new.txt'); // does not exist yet

  // The OLD plain check trusts the unresolved path (this is the gap):
  // assertTrustedPath would have allowed it. The create-aware check resolves the
  // junction's real target (outside the root) and rejects.
  assert.throws(() => assertTrustedPathForCreate(escaped, root), /escaped trusted root/i);

  // A legitimate brand-new file inside the root still passes.
  const ok = assertTrustedPathForCreate(path.join(root, 'sub', 'dir', 'ok.txt'), root);
  assert.ok(ok.endsWith('ok.txt'));

  // And the plain check still works for existing in-root paths.
  fs.mkdirSync(path.join(root, 'real'), { recursive: true });
  fs.writeFileSync(path.join(root, 'real', 'f.txt'), 'hi');
  assert.ok(assertTrustedPath(path.join(root, 'real', 'f.txt'), root).endsWith('f.txt'));
});
