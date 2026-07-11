// 落盘加密信封(切片 2b)——DEK 密钥箱 + seal/open + 开关 + 兼容遗留明文
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  AtRestKeyError,
  isAtRestEncryptionEnabled,
  resolveAtRestProtector,
  sealAtRest,
  openAtRest,
  atRestKeyPath,
  clearAtRestProtectorCache,
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

test('resolveAtRestProtector never replaces an existing invalid or unopenable keybox', () => {
  const cases = [
    {
      keybox: 'not-a-sealed-keybox',
      unprotect() { return '0'.repeat(64); },
    },
    {
      keybox: 'aesgcm:v1:old:keybox:value',
      unprotect() { throw new Error('test keybox cannot be opened'); },
    },
    {
      keybox: 'aesgcm:v1:old:keybox:value',
      unprotect() { return 'not-a-valid-dek'; },
    },
  ];
  for (const scenario of cases) {
    const dir = secDir();
    const keyFile = atRestKeyPath(dir);
    fs.writeFileSync(keyFile, scenario.keybox, 'utf8');
    const before = fs.readFileSync(keyFile);
    let protectCalls = 0;
    try {
      assert.throws(
        () => resolveAtRestProtector(dir, {
          fresh: true,
          credentialProtector: {
            protect() {
              protectCalls += 1;
              return 'test-must-not-replace-keybox';
            },
            unprotect: scenario.unprotect,
          },
        }),
        /at-rest key file.*corrupt|decrypt|invalid/i,
      );
      assert.equal(protectCalls, 0);
      assert.deepEqual(fs.readFileSync(keyFile), before);
      assert.deepEqual(fs.readdirSync(dir).sort(), [path.basename(keyFile)]);
    } finally {
      clearAtRestProtectorCache();
    }
  }
});

test('resolveAtRestProtector validates a newly wrapped DEK before publishing any keybox', () => {
  const foreignKeybox = kek.protect('a'.repeat(64));
  const brokenProtectors = [
    {
      protect() { return 'not-a-sealed-keybox'; },
      unprotect() { return '0'.repeat(64); },
    },
    {
      protect() { return foreignKeybox; },
      unprotect() { return 'b'.repeat(64); },
    },
    {
      protect() { return foreignKeybox; },
      unprotect() { throw new Error('test cannot unwrap its own output'); },
    },
  ];
  for (const credentialProtector of brokenProtectors) {
    const dir = path.join(secDir(), 'security');
    assert.throws(
      () => resolveAtRestProtector(dir, { credentialProtector, fresh: true }),
      /at-rest.*key|credential protector/i,
    );
    assert.equal(fs.existsSync(atRestKeyPath(dir)), false);
    assert.equal(fs.existsSync(dir), false, 'failed validation must not create the security directory');
  }
});

test('a partial candidate keybox write is cleaned up before the error escapes', () => {
  const dir = path.join(secDir(), 'security');
  const keyFile = atRestKeyPath(dir);
  const originalWriteFileSync = fs.writeFileSync;
  fs.writeFileSync = ((...args: unknown[]) => {
    const [destination] = args;
    if (typeof destination === 'number') {
      const writeDescriptor = originalWriteFileSync as unknown as (
        descriptor: number,
        data: string,
        encoding: string,
      ) => void;
      writeDescriptor(destination, 'partial-keybox', 'utf8');
      throw new Error('injected partial keybox write failure');
    }
    return Reflect.apply(originalWriteFileSync, fs, args);
  }) as typeof fs.writeFileSync;

  try {
    assert.throws(
      () => resolveAtRestProtector(dir, { credentialProtector: kek, fresh: true }),
      /injected partial keybox write failure/,
    );
  } finally {
    fs.writeFileSync = originalWriteFileSync;
    clearAtRestProtectorCache();
  }

  assert.equal(fs.existsSync(keyFile), false);
  assert.deepEqual(fs.readdirSync(dir), []);
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
  resolveAtRestProtector(dir, { credentialProtector: kek });
  const alienSealed = createAesGcmProtector({ keyMaterial: 'another-machine-key' }).protect('secret');
  // 密钥箱本身有效，但单条密文由别的 DEK 封印 → 仅该条返回 null。
  const result = openAtRest(alienSealed, dir, { credentialProtector: kek, env: { KCW_ENCRYPT_AT_REST: '1' } });
  assert.equal(result, null);
});

test('openAtRest reports a typed missing-key error without creating a keybox', () => {
  const securityDir = path.join(secDir(), 'missing-security-dir');
  const sealed = createAesGcmProtector({ keyMaterial: 'test-alien-data-key' }).protect('secret');

  assert.throws(
    () => openAtRest(sealed, securityDir, { credentialProtector: kek }),
    (error) => error instanceof AtRestKeyError
      && error.code === 'AT_REST_KEY_ERROR'
      && error.statusCode === 500,
  );
  assert.equal(fs.existsSync(securityDir), false);
  assert.equal(fs.existsSync(atRestKeyPath(securityDir)), false);
});

test('sealAtRest invalidates a stale cache entry when the keybox was purged', () => {
  const dir = secDir();
  const options = {
    credentialProtector: kek,
    env: { KCW_ENCRYPT_AT_REST: '1' },
  };
  const firstSealed = sealAtRest('before-purge', dir, options);
  const keyFile = atRestKeyPath(dir);
  const firstKeybox = fs.readFileSync(keyFile, 'utf8');

  fs.unlinkSync(keyFile);
  const secondSealed = sealAtRest('after-purge', dir, options);
  const secondKeybox = fs.readFileSync(keyFile, 'utf8');

  (assert as typeof assert & {
    notEqual(actual: unknown, expected: unknown, message?: string): void;
  }).notEqual(secondKeybox, firstKeybox, 'a purged keybox must be replaced with a fresh DEK');
  clearAtRestProtectorCache();
  assert.equal(openAtRest(secondSealed, dir, options), 'after-purge');
  assert.equal(openAtRest(firstSealed, dir, options), null, 'ciphertext from the purged DEK is no longer recoverable');
});

test('concurrent keybox creation adopts the atomically published winner and removes its temp file', () => {
  const dir = secDir();
  const keyFile = atRestKeyPath(dir);
  const winnerDek = 'b'.repeat(64);
  const winnerKeybox = kek.protect(winnerDek);
  const winnerProtector = createAesGcmProtector({ keyMaterial: winnerDek });
  const mutableFs = fs as unknown as {
    linkSync(source: string, destination: string): void;
  };
  const originalLinkSync = mutableFs.linkSync;
  let linkCalls = 0;
  mutableFs.linkSync = (_source, destination) => {
    linkCalls += 1;
    fs.writeFileSync(destination, winnerKeybox, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    const existsError = new Error('simulated concurrent publisher won') as Error & { code: string };
    existsError.code = 'EEXIST';
    throw existsError;
  };
  try {
    const resolved = resolveAtRestProtector(dir, { credentialProtector: kek, fresh: true });
    const winnerSealed = winnerProtector.protect('winner-data-key');
    assert.equal(resolved.unprotect(winnerSealed), 'winner-data-key');
    assert.equal(linkCalls, 1);
    assert.equal(fs.readFileSync(keyFile, 'utf8'), winnerKeybox);
    assert.deepEqual(fs.readdirSync(dir).sort(), [path.basename(keyFile)]);
  } finally {
    mutableFs.linkSync = originalLinkSync;
    clearAtRestProtectorCache();
  }
});
