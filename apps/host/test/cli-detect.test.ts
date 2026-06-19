import assert from 'node:assert/strict';
import test from 'node:test';
import { detectKimiInfo, parseKimiVersion, parseKimiInfo } from '../src/kimi/cli-detect.js';
import { createFakeChild } from './helpers/mcp.js';
import type { FakeChild } from './helpers/mcp.js';

type SpawnCall = {
  command: string;
  args: string[];
  options: Record<string, unknown>;
};
type DetectSpawn = NonNullable<Parameters<typeof detectKimiInfo>[1]>;

function makeDetectSpawn(script: (child: FakeChild, call: SpawnCall) => void) {
  const calls: SpawnCall[] = [];
  const spawn = (command: string, args: string[], options: unknown): FakeChild => {
    const child = createFakeChild();
    const call = { command, args, options: options as Record<string, unknown> };
    calls.push(call);
    setTimeout(() => script(child, call), 0);
    return child;
  };
  return { spawn: spawn as unknown as DetectSpawn, calls };
}

test('parseKimiVersion handles standard version text', () => {
  const version = parseKimiVersion('kimi, version 1.39.0');
  assert.equal(version, '1.39.0');
});

test('parseKimiInfo handles info output', () => {
  const info = parseKimiInfo(`
kimi-cli version: 1.39.0
wire protocol: 1.9
python version: 3.13.13
`);
  assert.equal(info.version, '1.39.0');
  assert.equal(info.wireProtocol, '1.9');
  assert.equal(info.pythonVersion, '3.13.13');
});

test('detectKimiInfo runs version and info commands without shell', async () => {
  const fake = makeDetectSpawn((child, call) => {
    if (call.args[0] === '--version') {
      child.stdout.emit('data', 'kimi, version 1.40.0\n');
      child.emit('close', 0);
      return;
    }
    child.stdout.emit('data', 'wire protocol: 2.0\npython version: 3.13.13\n');
    child.emit('close', 0);
  });

  const info = await detectKimiInfo('kimi-test', fake.spawn);

  assert.deepEqual(fake.calls.map((call) => call.args), [['--version'], ['info']]);
  assert.equal(fake.calls[0]?.command, 'kimi-test');
  assert.equal(fake.calls[0]?.options.shell, false);
  assert.equal(info.command, 'kimi-test');
  assert.equal(info.version, '1.40.0');
  assert.equal(info.wireProtocol, '2.0');
  assert.equal(info.pythonVersion, '3.13.13');
});

test('detectKimiInfo prefers info version and rejects failed commands', async () => {
  const infoVersion = makeDetectSpawn((child, call) => {
    child.stdout.emit('data', call.args[0] === '--version'
      ? 'kimi, version 1.39.0\n'
      : 'kimi-cli version: 1.41.0\n');
    child.emit('close', 0);
  });
  assert.equal((await detectKimiInfo('kimi-test', infoVersion.spawn)).version, '1.41.0');

  const failed = makeDetectSpawn((child) => {
    child.stderr.emit('data', 'not found');
    child.emit('close', 127);
  });
  await assert.rejects(
    () => detectKimiInfo('kimi-test', failed.spawn),
    /Command kimi-test --version failed: not found/,
  );

  const spawnError = makeDetectSpawn((child) => {
    child.emit('error', new Error('spawn failed'));
  });
  await assert.rejects(
    () => detectKimiInfo('kimi-test', spawnError.spawn),
    /spawn failed/,
  );
});
