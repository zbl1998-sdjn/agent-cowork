import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createManagedDirectoryBoundary } from '../src/security/managed-directory-boundary.js';

type SymlinkSync = (target: string, linkPath: string, type?: 'file' | 'dir' | 'junction') => void;
const symlinkSync = (fs as unknown as { symlinkSync: SymlinkSync }).symlinkSync;

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-managed-boundary-'));
}

test('managed boundary rejects same-root intermediate junctions for every consumer shape', {
  skip: process.platform !== 'win32',
}, (t) => {
  const root = tempRoot();
  const sibling = path.join(root, 'sibling');
  fs.mkdirSync(sibling);
  fs.writeFileSync(path.join(sibling, 'existing.json'), '{"owner":"sibling"}\n', 'utf8');
  const boundary = createManagedDirectoryBoundary(root, { create: false, label: 'Shared managed root' });

  for (const consumer of ['knowledge', 'scheduler', 'at-rest', 'artifact'] as const) {
    const alias = path.join(root, `${consumer}-namespace`);
    try {
      symlinkSync(sibling, alias, 'junction');
    } catch (error) {
      t.skip(`junction unavailable: ${String(error)}`);
      return;
    }
    assert.throws(
      () => boundary.inspectPath(path.join(alias, 'existing.json'), { kind: 'file' }),
      /symbolic link|junction|reparse|managed path/i,
      `${consumer} existing target`,
    );
    assert.throws(
      () => boundary.inspectPath(path.join(alias, 'new.json'), { allowMissing: true, kind: 'file' }),
      /symbolic link|junction|reparse|managed path/i,
      `${consumer} create target`,
    );
  }
});

test('one mutation guard pins regular ancestor identity while the leaf is missing', () => {
  const root = tempRoot();
  const namespace = path.join(root, 'owners', 'tenant-a');
  const displaced = path.join(root, 'tenant-a-original');
  const candidate = path.join(namespace, 'knowledge.json');
  fs.mkdirSync(namespace, { recursive: true });
  const boundary = createManagedDirectoryBoundary(root, { create: false, label: 'Shared managed root' });
  const guard = (boundary as unknown as {
    createMutationGuard(): (candidatePath: string) => void;
  }).createMutationGuard();

  guard(candidate);
  fs.renameSync(namespace, displaced);
  fs.mkdirSync(namespace);

  assert.throws(
    () => guard(candidate),
    /changed during operation/i,
  );
});
