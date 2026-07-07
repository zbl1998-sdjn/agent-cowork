// 落盘加密信封(切片 2b)——DEK 密钥箱 + seal/open + 开关 + 兼容遗留明文
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  isAtRestEncryptionEnabled,
  resolveAtRestProtector,
  sealAtRest,
  openAtRest,
  atRestKeyPath,
  setAtRestSecurityMode,
} from '../src/security/at-rest.js';
import { createAesGcmProtector, isSealedCredential } from '../src/security/credential-store.js';

function secDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-atrest-'));
}
// 注入 AES credential-protector 作 KEK,避免测试真机拉 DPAPI/PowerShell。
const kek = createAesGcmProtector({ keyMaterial: 'at-rest-test-kek' });

test('isAtRestEncryptionEnabled: tier-bound default policy (hardened)', () => {
  setAtRestSecurityMode(null); // 用 env 解析,确定性
  // 标准档(controlled_hybrid 默认 / local_demo):默认关,可显式开
  assert.equal(isAtRestEncryptionEnabled({}), false, 'standard tier off by default');
  assert.equal(isAtRestEncryptionEnabled({ KCW_SECURITY_MODE: 'local_demo' }), false);
  assert.equal(isAtRestEncryptionEnabled({ KCW_ENCRYPT_AT_REST: '1' }), true, 'explicit on');
  // 本地严格 / 企业内网:默认开,可显式关
  assert.equal(isAtRestEncryptionEnabled({ KCW_SECURITY_MODE: 'local_strict' }), true, 'local_strict on by default');
  assert.equal(isAtRestEncryptionEnabled({ KCW_SECURITY_MODE: 'enterprise_local' }), true, 'enterprise_local on by default');
  assert.equal(isAtRestEncryptionEnabled({ KCW_SECURITY_MODE: 'enterprise_local', KCW_ENCRYPT_AT_REST: '0' }), false, 'disable-able outside air_gap');
  // 隔离档 air_gap(含机密总开关):强制开,显式关也不削弱
  assert.equal(isAtRestEncryptionEnabled({ KCW_SECURITY_MODE: 'air_gap' }), true);
  assert.equal(isAtRestEncryptionEnabled({ KCW_SECURITY_MODE: 'air_gap', KCW_ENCRYPT_AT_REST: 'off' }), true, 'air_gap non-disableable (fail-closed)');
  assert.equal(isAtRestEncryptionEnabled({ KCW_CONFIDENTIAL: '1', KCW_ENCRYPT_AT_REST: 'false' }), true, 'confidential non-disableable');
});

test('setAtRestSecurityMode override wins over env (config-driven mode reaches stores)', () => {
  try {
    setAtRestSecurityMode('air_gap'); // 模拟 config 设 air_gap、env 无 KCW_SECURITY_MODE
    assert.equal(isAtRestEncryptionEnabled({}), true, 'config-set air_gap forces encryption even with empty env');
    setAtRestSecurityMode('local_demo');
    assert.equal(isAtRestEncryptionEnabled({}), false, 'config-set standard tier defaults off');
  } finally {
    setAtRestSecurityMode(null);
  }
});

test('resolveAtRestProtector creates a wrapped-DEK keyfile once and reuses it', () => {
  const dir = secDir();
  const p1 = resolveAtRestProtector(dir, { credentialProtector: kek });
  assert.ok(fs.existsSync(atRestKeyPath(dir)), 'keyfile was created');
  // keyfile 存的是被 KEK 封印的 DEK,不是明文
  assert.ok(isSealedCredential(fs.readFileSync(atRestKeyPath(dir), 'utf8').trim()));
  // 同一密钥箱解出同一 DEK:p1 封印的能被"重新解析"的 protector 解开
  const sealed = p1.protect('hello-dek');
  const p2 = resolveAtRestProtector(dir, { credentialProtector: kek, fresh: true });
  assert.equal(p2.unprotect(sealed), 'hello-dek', 'same DEK recovered from keyfile');
});

test('sealAtRest encrypts only when enabled; openAtRest is transparent for sealed + legacy', () => {
  const dir = secDir();
  const opts = { credentialProtector: kek, env: { KCW_ENCRYPT_AT_REST: '1' } as Record<string, string> };
  const sealed = sealAtRest('{"secret":"abc123"}', dir, opts);
  assert.ok(!sealed.includes('abc123'), 'plaintext must not survive in sealed output');
  assert.ok(isSealedCredential(sealed));
  assert.equal(openAtRest(sealed, dir, opts), '{"secret":"abc123"}', 'sealed round-trips');
  // 关闭时不加密
  const off = sealAtRest('{"x":1}', dir, { credentialProtector: kek, env: {} });
  assert.equal(off, '{"x":1}');
  // 读侧对遗留明文透传(迁移友好)
  assert.equal(openAtRest('{"legacy":true}', dir, opts), '{"legacy":true}');
});

test('openAtRest returns null for an unopenable sealed blob (moved machine / rotated key)', () => {
  const dir = secDir();
  const alienSealed = createAesGcmProtector({ keyMaterial: 'another-machine' }).protect('secret');
  // 用不同 KEK 的 DEK 封的密文,当前密钥箱开不了 → null,由调用方按损坏跳过
  const result = openAtRest(alienSealed, dir, { credentialProtector: kek, env: { KCW_ENCRYPT_AT_REST: '1' } });
  assert.equal(result, null);
});
