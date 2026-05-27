import assert from 'node:assert/strict';
import test from 'node:test';
import { isBlockedIp, numericHostToV4, assertPublicHost } from '../src/tools/ssrf-guard.js';

test('isBlockedIp covers private/reserved/loopback IPv4 ranges', () => {
  for (const ip of [
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255',
  ]) {
    assert.equal(isBlockedIp(ip), true, `${ip} should be blocked`);
  }
});

test('isBlockedIp allows public IPv4 (incl. 172.x outside 172.16/12)', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '93.184.216.34']) {
    assert.equal(isBlockedIp(ip), false, `${ip} should be allowed`);
  }
});

test('isBlockedIp covers IPv6 loopback/ULA/link-local/multicast/mapped', () => {
  for (const ip of ['::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1']) {
    assert.equal(isBlockedIp(ip), true, `${ip} should be blocked`);
  }
  assert.equal(isBlockedIp('2606:4700:4700::1111'), false);
});

test('numericHostToV4 normalizes decimal/hex/octal IPv4 forms', () => {
  assert.deepEqual(numericHostToV4('2130706433'), [127, 0, 0, 1]);
  assert.deepEqual(numericHostToV4('0x7f000001'), [127, 0, 0, 1]);
  assert.deepEqual(numericHostToV4('127.0.0.1'), [127, 0, 0, 1]);
  assert.equal(numericHostToV4('example.com'), null);
});

test('assertPublicHost blocks localhost names without a DNS round-trip', async () => {
  await assert.rejects(() => assertPublicHost('localhost'), /blocked/);
  await assert.rejects(() => assertPublicHost('foo.localhost'), /blocked/);
});

test('assertPublicHost blocks numeric-encoded loopback (string bypass)', async () => {
  await assert.rejects(() => assertPublicHost('2130706433'), /blocked/);
  await assert.rejects(() => assertPublicHost('0x7f000001'), /blocked/);
});

test('assertPublicHost blocks a name that RESOLVES to an internal IP (DNS rebinding)', async () => {
  const lookupImpl = async () => [{ address: '169.254.169.254' }];
  await assert.rejects(() => assertPublicHost('metadata.evil.test', { lookupImpl }), /blocked/);
});

test('assertPublicHost rejects when ANY resolved address is internal', async () => {
  const lookupImpl = async () => [{ address: '93.184.216.34' }, { address: '10.0.0.5' }];
  await assert.rejects(() => assertPublicHost('split.evil.test', { lookupImpl }), /blocked/);
});

test('assertPublicHost allows a name that resolves only to public IPs', async () => {
  const lookupImpl = async () => [{ address: '93.184.216.34' }];
  await assert.doesNotReject(() => assertPublicHost('example.com', { lookupImpl }));
});

test('assertPublicHost blocks a literal IPv6 ULA host', async () => {
  await assert.rejects(() => assertPublicHost('[fd00::1]'), /blocked/);
});
