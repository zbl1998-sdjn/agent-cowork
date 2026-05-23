import assert from 'node:assert/strict';
import test from 'node:test';
import childProcess from 'node:child_process';
import { createCappedBuffer, runConstrainedChild } from '../src/sandbox/exec-child.js';

test('createCappedBuffer: retains at most maxBytes, counts the rest, flags truncation', () => {
  const sink = createCappedBuffer(10);
  sink.push(Buffer.from('hello')); // 5
  sink.push(Buffer.from('world!!')); // +7 -> total 12, only 5 more retained (cap 10)
  assert.equal(sink.text, 'helloworld'); // exactly 10 bytes retained
  assert.equal(sink.text.length, 10);
  assert.equal(sink.bytes, 12); // total seen pre-truncation
  assert.equal(sink.truncated, true);
});

test('createCappedBuffer: under the cap is not truncated', () => {
  const sink = createCappedBuffer(1024);
  sink.push(Buffer.from('small output'));
  assert.equal(sink.text, 'small output');
  assert.equal(sink.truncated, false);
  assert.equal(sink.bytes, 12);
});

test('createCappedBuffer: bounds memory for a huge stream (retained << produced)', () => {
  const cap = 4096;
  const sink = createCappedBuffer(cap);
  // Feed 5 MB in 1 KB chunks; retained bytes must never exceed the cap.
  const chunk = Buffer.alloc(1024, 0x61);
  for (let i = 0; i < 5 * 1024; i += 1) sink.push(chunk);
  assert.equal(Buffer.byteLength(sink.text), cap);
  assert.equal(sink.bytes, 5 * 1024 * 1024);
  assert.equal(sink.truncated, true);
});

test('runConstrainedChild: high-output command is truncated to the cap, exit code preserved', async () => {
  const cap = 1000;
  const res = await runConstrainedChild({
    spawn: childProcess.spawn,
    command: process.execPath, // node
    args: ['-e', "process.stdout.write('x'.repeat(1000000)); process.exit(0)"],
    cwd: process.cwd(),
    env: process.env,
    timeoutMs: 10000,
    maxOutputBytes: cap,
  });
  assert.equal(res.exitCode, 0, 'a bounded command still finishes with its real exit code');
  assert.equal(res.timedOut, false);
  assert.equal(res.truncated, true);
  assert.ok(res.stdout.length <= cap, `retained stdout (${res.stdout.length}) must be <= cap (${cap})`);
  assert.equal(res.bytesStdout, 1000000, 'total produced bytes are still reported');
});

test('runConstrainedChild: normal small command is not truncated', async () => {
  const res = await runConstrainedChild({
    spawn: childProcess.spawn,
    command: process.execPath,
    args: ['-e', "process.stdout.write('ok')"],
    cwd: process.cwd(),
    env: process.env,
    timeoutMs: 10000,
    maxOutputBytes: 1024,
  });
  assert.equal(res.exitCode, 0);
  assert.equal(res.stdout, 'ok');
  assert.equal(res.truncated, false);
});
