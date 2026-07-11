import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { safeWriteSync } from '../src/memory/memory-utils.js';

test('safeWriteSync preserves the prior memory file when atomic close fails', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-memory-atomic-'));
  const directory = path.join(root, '.AgentCowork');
  const target = path.join(directory, 'MEMORY.md');
  const previousEncryption = process.env.KCW_ENCRYPT_AT_REST;
  process.env.KCW_ENCRYPT_AT_REST = '0';
  safeWriteSync(target, 'before');
  const before = fs.readFileSync(target);
  const originalCloseSync = fs.closeSync;
  let injected = false;
  fs.closeSync = ((descriptor: number) => {
    if (!injected) {
      injected = true;
      throw new Error('injected memory atomic close failure');
    }
    originalCloseSync(descriptor);
  }) as typeof fs.closeSync;

  try {
    assert.throws(() => safeWriteSync(target, 'after'), /injected memory atomic close failure/);
  } finally {
    fs.closeSync = originalCloseSync;
    if (previousEncryption === undefined) delete process.env.KCW_ENCRYPT_AT_REST;
    else process.env.KCW_ENCRYPT_AT_REST = previousEncryption;
  }

  assert.deepEqual(fs.readFileSync(target), before);
  assert.deepEqual(fs.readdirSync(directory), ['MEMORY.md']);
});
