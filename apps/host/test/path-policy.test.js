import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { assertReadableWorkspacePath, assertTrustedPath, isSensitivePath } from '../src/security/path-policy.js';
import { makeTestWorkspace } from './test-fixtures.js';

const root = makeTestWorkspace('kfcowork-root');
const workspace = path.join(root, 'workspace');
const outside = path.join(root, 'outside');
fs.mkdirSync(workspace, { recursive: true });
fs.mkdirSync(outside, { recursive: true });

describe('path-policy', () => {
  it('rejects escaped paths', () => {
    const badPath = path.join(root, 'outside', 'file.txt');
    assert.throws(() => assertTrustedPath(badPath, workspace), /trusted root/i);
  });

  it('rejects sensitive paths', () => {
    const sensitive = path.join(workspace, '.ssh', 'id_rsa');
    fs.mkdirSync(path.join(workspace, '.ssh'), { recursive: true });
    fs.writeFileSync(sensitive, 'do-not-read', 'utf8');
    assert.throws(() => assertTrustedPath(sensitive, workspace), /sensitive/i);
  });

  it('canonicalizes and accepts normalized case-insensitive path on Windows', () => {
    if (process.platform !== 'win32') {
      return;
    }
    const nested = path.join(workspace, 'Nested');
    fs.mkdirSync(nested, { recursive: true });
    const nestedLower = nested.toLowerCase();
    const safe = assertTrustedPath(nestedLower, workspace);
    assert.equal(path.basename(safe), 'Nested');
  });

  it('flags sensitive extension quickly', () => {
    assert.equal(isSensitivePath(path.join(workspace, 'certs', 'deploy.key')), true);
  });

  it('does not block a normal write just because the root prefix contains a sensitive segment', () => {
    // Simulate a workspace whose absolute path includes "appdata" (e.g. an app
    // data dir). Writes BELOW the root must be allowed; the root prefix is trusted.
    const fakeRoot = path.join(root, 'AppData', 'Local', 'MyWorkspace');
    fs.mkdirSync(path.join(fakeRoot, 'docs'), { recursive: true });
    const normalFile = path.join(fakeRoot, 'docs', 'report.md');
    fs.writeFileSync(normalFile, '# ok', 'utf8');
    // relative-to-root form (used internally by assertTrustedPath) is NOT sensitive
    assert.equal(isSensitivePath(normalFile, fakeRoot), false);
    assert.ok(assertTrustedPath(normalFile, fakeRoot).endsWith('report.md'));
    // ...but a sensitive name created BELOW the root is still blocked.
    fs.mkdirSync(path.join(fakeRoot, '.ssh'), { recursive: true });
    fs.writeFileSync(path.join(fakeRoot, '.ssh', 'config'), 'x', 'utf8');
    assert.equal(isSensitivePath(path.join(fakeRoot, '.ssh', 'config'), fakeRoot), true);
    // Whole-path form (no root) keeps the legacy behaviour for direct callers.
    assert.equal(isSensitivePath(normalFile), true);
  });

  it('does not block a normal read when trusted root is a non-canonical alias under AppData', () => {
    const realRoot = path.join(root, 'AppData', 'Local', 'ReadWorkspace');
    const aliasRoot = path.join(root, 'read-alias');
    fs.mkdirSync(path.join(realRoot, 'docs'), { recursive: true });
    try {
      fs.symlinkSync(realRoot, aliasRoot, 'junction');
    } catch {
      fs.symlinkSync(realRoot, aliasRoot);
    }
    const note = path.join(aliasRoot, 'docs', 'note.txt');
    fs.writeFileSync(note, 'ok', 'utf8');

    const safe = assertReadableWorkspacePath(note, aliasRoot);

    assert.equal(path.basename(safe), 'note.txt');
  });
});
