import assert from 'node:assert/strict';
import test from 'node:test';
import childProcess from 'node:child_process';
import { createCappedBuffer, runConstrainedChild } from '../src/sandbox/exec-child.js';
import type { SpawnLike } from '../src/sandbox/exec-child.js';

const spawn = childProcess.spawn as unknown as SpawnLike;

function currentNodeCommand(): string {
  assert.ok(process.execPath);
  return process.execPath;
}

function stringEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

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
  const chunk = Buffer.from('a'.repeat(1024));
  for (let i = 0; i < 5 * 1024; i += 1) sink.push(chunk);
  assert.equal(Buffer.byteLength(sink.text), cap);
  assert.equal(sink.bytes, 5 * 1024 * 1024);
  assert.equal(sink.truncated, true);
});

test('runConstrainedChild: high-output command is truncated to the cap, exit code preserved', async () => {
  const cap = 1000;
  const res = await runConstrainedChild({
    spawn,
    command: currentNodeCommand(), // node
    args: ['-e', "process.stdout.write('x'.repeat(1000000), () => process.exit(0))"],
    cwd: process.cwd(),
    env: stringEnv(),
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
    spawn,
    command: currentNodeCommand(),
    args: ['-e', "process.stdout.write('ok')"],
    cwd: process.cwd(),
    env: stringEnv(),
    timeoutMs: 10000,
    maxOutputBytes: 1024,
  });
  assert.equal(res.exitCode, 0);
  assert.equal(res.stdout, 'ok');
  assert.equal(res.truncated, false);
});

test('runConstrainedChild: aborting the signal SIGKILLs the in-flight child (cancel really stops shell)', async () => {
  // 一个会跑 60s 的子进程 + 30s 硬超时;150ms 时取消。
  // 若取消真的 kill 了子进程,本调用应在几百毫秒内返回(而非 30s 超时或 60s 自然结束)。
  const controller = new AbortController();
  const startedAt = Date.now();
  setTimeout(() => controller.abort(), 150);
  const res = await runConstrainedChild({
    spawn,
    command: currentNodeCommand(),
    args: ['-e', 'setTimeout(() => process.exit(0), 60000)'],
    cwd: process.cwd(),
    env: stringEnv(),
    timeoutMs: 30000,
    maxOutputBytes: 1024,
    abortSignal: controller.signal,
  });
  const elapsedMs = Date.now() - startedAt;
  assert.ok(elapsedMs < 5000, `aborted child must return promptly (~150ms), got ${elapsedMs}ms (~60s if not killed)`);
  assert.equal(res.timedOut, false, 'an abort-kill is not a timeout');
});

// 回归:真实 Shell 是 powershell.exe -Command "<长命令>",长命令(ping)是孙进程。
// 旧实现只 kill powershell 壳 → ping 孤儿继续跑、其继承的管道不关 → 'close' 要等 ~59s,取消无效(live 实测 55s)。
// 上面的单进程用例 kill 得掉、掩盖了这点;这里 spawn 整棵树,验证 abort 杀树后秒级返回。Windows 专用。
test('runConstrainedChild: aborting a shell-wrapper kills the whole process tree, not just the wrapper (Windows)', { skip: process.platform !== 'win32' }, async () => {
  const controller = new AbortController();
  const startedAt = Date.now();
  setTimeout(() => controller.abort(), 400);
  const res = await runConstrainedChild({
    spawn,
    command: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-Command', 'ping -n 60 127.0.0.1'],
    cwd: process.cwd(),
    env: stringEnv(),
    timeoutMs: 90000,
    maxOutputBytes: 1024 * 1024,
    abortSignal: controller.signal,
  });
  const elapsedMs = Date.now() - startedAt;
  assert.ok(elapsedMs < 8000, `tree-kill must return promptly, got ${elapsedMs}ms (~59s if grandchild ping not killed)`);
  assert.equal(res.timedOut, false, 'an abort-kill is not a timeout');
});
