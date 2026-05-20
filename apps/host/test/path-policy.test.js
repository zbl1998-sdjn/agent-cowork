import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { assertTrustedPath, isSensitivePath } from '../src/security/path-policy.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kfcowork-root-'));
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
});
