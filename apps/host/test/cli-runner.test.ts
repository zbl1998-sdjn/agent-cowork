import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  buildKimiChatPrompt,
  buildKimiCliChatArgs,
  buildKimiCliPlanArgs,
  buildKimiPlanPrompt,
  runKimiCliChat,
  runKimiCliPlan,
} from '../src/engine/cli-runner.js';
import { decodeCliOutput } from '../src/engine/cli-output.js';
import { createFakeChild } from './helpers/mcp.js';
import type { FakeChild } from './helpers/mcp.js';

function stringArg(args: string[], index: number): string {
  const value = args[index];
  assert.ok(value);
  return value;
}

type FakeKimiChild = FakeChild & { killCount: number };
type KimiSpawn = NonNullable<NonNullable<Parameters<typeof runKimiCliChat>[0]>['spawn']>;

type SpawnCall = {
  command: string;
  args: string[];
  options: Record<string, unknown>;
};

function makeFakeSpawn(script: (child: FakeKimiChild) => void) {
  const calls: SpawnCall[] = [];
  const children: FakeKimiChild[] = [];
  const spawn = (command: string, args: string[], options: unknown): FakeKimiChild => {
    const child = createFakeChild() as FakeKimiChild;
    child.killCount = 0;
    child.kill = () => {
      child.killCount += 1;
      child.emit('close', null);
    };
    calls.push({ command, args, options: options as Record<string, unknown> });
    children.push(child);
    setTimeout(() => script(child), 0);
    return child;
  };
  return { spawn: spawn as unknown as KimiSpawn, calls, children };
}

test('buildKimiPlanPrompt constrains Kimi CLI to plan-only output', () => {
  const prompt = buildKimiPlanPrompt({
    mode: 'code',
    summary: '合同草稿包含 renewal date。',
    prompt: '生成整理计划',
  });

  assert.match(prompt, /只基于下面摘要回答/);
  assert.match(prompt, /不要修改文件/);
  assert.match(prompt, /不要使用工具/);
  assert.match(prompt, /模式：code/);
  assert.match(prompt, /renewal date/);
  assert.match(prompt, /生成整理计划/);
});

test('decodeCliOutput handles empty, UTF-8, and invalid byte chunks without throwing', () => {
  assert.equal(decodeCliOutput([]), '');
  assert.equal(decodeCliOutput([Buffer.from('第一行'), Buffer.from('\nsecond')]), '第一行\nsecond');
  assert.doesNotThrow(() => decodeCliOutput([Buffer.from([0xff, 0xfe, 0xfd])]));
  assert.ok(decodeCliOutput([Buffer.from([0xff, 0xfe, 0xfd])]).length > 0);
});

test('buildKimiCliPlanArgs uses non-interactive plan mode with trusted root', () => {
  const args = buildKimiCliPlanArgs({
    trustedRoot: 'C:\\workspace',
    prompt: '列出计划',
    summary: '本地摘要',
    mode: 'cowork',
    maxSteps: 2,
    model: 'kimi-test',
  });

  assert.deepEqual(args.slice(0, 7), [
    '--work-dir',
    'C:\\workspace',
    '--print',
    '--final-message-only',
    '--max-steps-per-turn',
    '2',
    '--model',
  ]);
  assert.equal(args[7], 'kimi-test');
  assert.equal(args[8], '--prompt');
  assert.match(stringArg(args, 9), /本地摘要/);
});

test('buildKimiCliPlanArgs rejects empty prompts', () => {
  assert.throws(
    () => buildKimiCliPlanArgs({ trustedRoot: 'C:\\workspace', prompt: '   ' }),
    /prompt is required/,
  );
});

test('buildKimiChatPrompt constrains chat to host-provided context', () => {
  const prompt = buildKimiChatPrompt({
    summary: '已上传 invoice.pdf。',
    prompt: '这个文件能做什么？',
  });

  assert.match(prompt, /本地对话核心/);
  assert.match(prompt, /Host 提供的摘要/);
  assert.match(prompt, /不要读取文件/);
  assert.match(prompt, /invoice\.pdf/);
  assert.match(prompt, /这个文件能做什么/);
});

test('buildKimiCliChatArgs uses non-interactive chat mode', () => {
  const args = buildKimiCliChatArgs({
    trustedRoot: 'C:\\workspace',
    prompt: '你好',
    summary: '摘要',
    maxSteps: 3,
  });

  assert.deepEqual(args.slice(0, 6), [
    '--work-dir',
    'C:\\workspace',
    '--print',
    '--final-message-only',
    '--max-steps-per-turn',
    '3',
  ]);
  assert.equal(args[6], '--prompt');
  assert.match(stringArg(args, 7), /用户消息：你好/);
});

test('runKimiCliChat returns sanitized CLI output and cleans its temp workspace', async () => {
  const fake = makeFakeSpawn((child) => {
    child.stdout.emit('data', Buffer.from('  回答第一行\r\n第二行  '));
    child.emit('close', 0);
  });

  const result = await runKimiCliChat({
    command: 'C:\\tools\\kimi.exe',
    spawn: fake.spawn,
    prompt: '你好',
    summary: '摘要',
    maxSteps: 2,
    model: 'kimi-test',
  });

  const call = fake.calls[0];
  assert.ok(call, 'spawn call recorded');
  assert.equal(call.command, 'C:\\tools\\kimi.exe');
  assert.equal(call.options.shell, false);
  assert.equal(call.options.windowsHide, true);
  assert.equal((call.options.env as Record<string, string>).PYTHONUTF8, '1');
  assert.equal(fs.existsSync(String(call.options.cwd)), false, 'temp cwd is removed after close');
  assert.match(call.args.join('\n'), /--final-message-only/);
  assert.match(call.args.join('\n'), /kimi-test/);
  assert.deepEqual(result, {
    ok: true,
    provider: 'kimi-cli',
    command: 'kimi.exe',
    mode: 'chat',
    text: '回答第一行\n第二行',
    durationMs: result.durationMs,
  });
  assert.equal(typeof result.durationMs, 'number');
});

test('runKimiCliPlan rejects nonzero and empty CLI output', async () => {
  const failed = makeFakeSpawn((child) => {
    child.stderr.emit('data', 'bad credentials');
    child.emit('close', 2);
  });
  await assert.rejects(
    () => runKimiCliPlan({ command: 'kimi', spawn: failed.spawn, prompt: '列计划' }),
    /Kimi CLI exited 2: bad credentials/,
  );

  const empty = makeFakeSpawn((child) => {
    child.stdout.emit('data', '   \r\n');
    child.emit('close', 0);
  });
  await assert.rejects(
    () => runKimiCliPlan({ command: 'kimi', spawn: empty.spawn, prompt: '列计划' }),
    /empty output/,
  );
});

test('runKimiCliChat cleans temp workspace when spawn emits an error', async () => {
  const failed = makeFakeSpawn((child) => {
    child.emit('error', new Error('spawn failed'));
  });

  await assert.rejects(
    () => runKimiCliChat({ command: 'kimi', spawn: failed.spawn, prompt: '你好' }),
    /spawn failed/,
  );

  const cwd = failed.calls[0]?.options.cwd;
  assert.ok(cwd);
  assert.equal(fs.existsSync(String(cwd)), false);
});

test('runKimiCliChat kills hung or oversized CLI output', async () => {
  const hung = makeFakeSpawn(() => undefined);
  await assert.rejects(
    () => runKimiCliChat({ command: 'kimi', spawn: hung.spawn, prompt: '你好', timeoutMs: 1 }),
    /timed out after 1ms/,
  );
  assert.equal(hung.children[0]?.killCount, 1);

  const oversized = makeFakeSpawn((child) => {
    child.stdout.emit('data', Buffer.from('x'.repeat(256 * 1024 + 1)));
  });
  await assert.rejects(
    () => runKimiCliChat({ command: 'kimi', spawn: oversized.spawn, prompt: '你好' }),
    /Kimi CLI exited null:/,
  );
  assert.equal(oversized.children[0]?.killCount, 1);
});
