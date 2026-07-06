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
} from '../src/security/at-rest.js';
import { createAesGcmProtector, isSealedCredential } from '../src/security/credential-store.js';

function secDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-atrest-'));
}
// 注入 AES credential-protector 作 KEK,避免测试真机拉 DPAPI/PowerShell。
const kek = createAesGcmProtector({ keyMaterial: 'at-rest-test-kek' });

test('isAtRestEncryptionEnabled: explicit flag or confidential mode turns it on', () => {
  assert.equal(isAtRestEncryptionEnabled({}), false);
  assert.equal(isAtRestEncryptionEnabled({ KCW_ENCRYPT_AT_REST: '1' }), true);
  assert.equal(isAtRestEncryptionEnabled({ KCW_ENCRYPT_AT_REST: 'off' }), false);
  assert.equal(isAtRestEncryptionEnabled({ KCW_CONFIDENTIAL: '1' }), true);
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
