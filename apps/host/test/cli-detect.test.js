import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { parseKimiVersion, parseKimiInfo } from '../src/kimi/cli-detect.js';

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
