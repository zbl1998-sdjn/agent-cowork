import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonlWriter } from '../src/storage/jsonl-writer.js';

test('JsonlWriter rotates by size and keeps maxFiles generations', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-jsonl-'));
  const file = path.join(dir, 'audit.jsonl');
  // tiny cap so a few records trigger rotation; keep 2 generations.
  const w = new JsonlWriter(file, { maxBytes: 200, maxFiles: 2 });
  for (let i = 0; i < 50; i += 1) w.append({ i, pad: 'x'.repeat(40) });

  assert.ok(fs.existsSync(file), 'live file exists');
  assert.ok(fs.existsSync(`${file}.1`), 'rotated .1 exists');
  // maxFiles=2 -> never keep a .2
  assert.ok(!fs.existsSync(`${file}.2`), '.2 should not exist (dropped beyond maxFiles)');
  // live file stays bounded (roughly under cap + one record).
  assert.ok(fs.statSync(file).size <= 400, 'live file is bounded');
  // content is valid JSONL.
  const last = fs.readFileSync(file, 'utf8').trim().split('\n').pop();
  assert.doesNotThrow(() => JSON.parse(last));
});

test('JsonlWriter without rotation pressure keeps a single file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-jsonl2-'));
  const file = path.join(dir, 'a.jsonl');
  const w = new JsonlWriter(file, { maxBytes: 1024 * 1024 });
  w.append({ ok: 1 }); w.append({ ok: 2 });
  assert.ok(!fs.existsSync(`${file}.1`), 'no rotation when under cap');
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 2);
});
