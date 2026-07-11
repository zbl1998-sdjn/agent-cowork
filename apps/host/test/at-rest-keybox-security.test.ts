import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  AtRestKeyError,
  atRestKeyPath,
  clearAtRestProtectorCache,
  openAtRest,
  resolveAtRestProtector,
} from '../src/security/at-rest.js';
import { createAesGcmProtector } from '../src/security/credential-store.js';

const credentialProtector = createAesGcmProtector({ keyMaterial: 'test-keybox-security-kek' });

type SymlinkSync = (target: string, linkPath: string, type?: 'file' | 'dir' | 'junction') => void;
const symlinkSync = (fs as unknown as { symlinkSync: SymlinkSync }).symlinkSync;

function linkDirectory(target: string, linkPath: string): void {
  try {
    symlinkSync(target, linkPath, 'junction');
  } catch {
    symlinkSync(target, linkPath, 'dir');
  }
}

function tempSecurityDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-at-rest-keybox-'));
}

function captureError(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error('expected action to throw');
}

function assertKeyError(error: unknown, expectedCause?: unknown): asserts error is AtRestKeyError {
  assert.ok(error instanceof AtRestKeyError);
  assert.equal(error.name, 'AtRestKeyError');
  assert.equal(error.code, 'AT_REST_KEY_ERROR');
  assert.equal(error.statusCode, 500);
  if (expectedCause !== undefined) assert.equal(error.cause, expectedCause);
}

test('missing and corrupt keyboxes throw typed errors without changing ciphertext bytes', async (t) => {
  const nested = t as unknown as { test(name: string, fn: () => void): Promise<void> };
  for (const scenario of ['missing', 'corrupt'] as const) {
    await nested.test(scenario, () => {
      const securityDir = tempSecurityDir();
      const keyFile = atRestKeyPath(securityDir);
      const dataProtector = resolveAtRestProtector(securityDir, { credentialProtector });
      const ciphertextFile = path.join(path.dirname(securityDir), `record-${scenario}.bin`);
      fs.writeFileSync(ciphertextFile, dataProtector.protect(`secret-${scenario}`));
      const ciphertextBefore = fs.readFileSync(ciphertextFile);

      if (scenario === 'missing') fs.unlinkSync(keyFile);
      else fs.writeFileSync(keyFile, 'corrupt-keybox', 'utf8');
      const keyboxBefore = fs.existsSync(keyFile) ? fs.readFileSync(keyFile) : null;
      clearAtRestProtectorCache();

      const error = captureError(() => openAtRest(
        fs.readFileSync(ciphertextFile, 'utf8'),
        securityDir,
        { credentialProtector },
      ));
      assertKeyError(error);
      assert.deepEqual(fs.readFileSync(ciphertextFile), ciphertextBefore);
      if (keyboxBefore === null) assert.equal(fs.existsSync(keyFile), false);
      else assert.deepEqual(fs.readFileSync(keyFile), keyboxBefore);
      clearAtRestProtectorCache();
    });
  }
});

test('an unreadable keybox preserves the filesystem error as the typed cause', () => {
  const securityDir = tempSecurityDir();
  const keyFile = atRestKeyPath(securityDir);
  const dataProtector = resolveAtRestProtector(securityDir, { credentialProtector });
  const ciphertext = dataProtector.protect('secret-eacces');
  clearAtRestProtectorCache();

  const accessError = Object.assign(new Error('injected keybox access denial'), { code: 'EACCES' });
  const originalReadFileSync = fs.readFileSync;
  fs.readFileSync = ((filePath: unknown, ...args: unknown[]) => {
    if (typeof filePath !== 'number' && path.resolve(String(filePath)) === path.resolve(keyFile)) {
      throw accessError;
    }
    return Reflect.apply(originalReadFileSync, fs, [filePath, ...args]);
  }) as typeof fs.readFileSync;
  try {
    const error = captureError(() => openAtRest(ciphertext, securityDir, { credentialProtector }));
    assertKeyError(error, accessError);
  } finally {
    fs.readFileSync = originalReadFileSync;
    clearAtRestProtectorCache();
  }
});

test('a keybox fsync failure publishes neither the keybox nor a temporary file', () => {
  const securityDir = path.join(tempSecurityDir(), 'security');
  const fsyncError = new Error('injected keybox fsync failure');
  const originalFsyncSync = fs.fsyncSync;
  fs.fsyncSync = (() => {
    throw fsyncError;
  }) as typeof fs.fsyncSync;
  try {
    const error = captureError(() => resolveAtRestProtector(securityDir, {
      credentialProtector,
      fresh: true,
    }));
    assertKeyError(error, fsyncError);
  } finally {
    fs.fsyncSync = originalFsyncSync;
    clearAtRestProtectorCache();
  }

  assert.equal(fs.existsSync(atRestKeyPath(securityDir)), false);
  assert.deepEqual(fs.readdirSync(securityDir), []);
});

test('a keybox directory junction is rejected without writing through it', (t) => {
  const container = tempSecurityDir();
  const outside = tempSecurityDir();
  const securityDir = path.join(container, 'security');
  try {
    linkDirectory(outside, securityDir);
  } catch (error) {
    t.skip(`symlink/junction unavailable: ${String(error)}`);
    return;
  }

  const error = captureError(() => resolveAtRestProtector(securityDir, {
    credentialProtector,
    fresh: true,
  }));
  assertKeyError(error);
  assert.match(error.message, /symbolic link|junction|reparse|managed directory/i);
  assert.deepEqual(fs.readdirSync(outside), []);
  clearAtRestProtectorCache();
});

test('a cached protector fails closed after its key directory is swapped', (t) => {
  const container = tempSecurityDir();
  const outside = tempSecurityDir();
  const securityDir = path.join(container, 'security');
  const displaced = path.join(container, 'security-original');
  fs.mkdirSync(securityDir);
  resolveAtRestProtector(securityDir, { credentialProtector });
  fs.renameSync(securityDir, displaced);
  try {
    linkDirectory(outside, securityDir);
  } catch (error) {
    fs.renameSync(displaced, securityDir);
    t.skip(`symlink/junction unavailable: ${String(error)}`);
    return;
  }

  const error = captureError(() => resolveAtRestProtector(securityDir, { credentialProtector }));
  assertKeyError(error);
  assert.match(error.message, /symbolic link|junction|reparse|managed directory/i);
  assert.deepEqual(fs.readdirSync(outside), []);
  clearAtRestProtectorCache();
});

test('keybox creation revalidates the directory after mkdir before publishing', (t) => {
  const container = tempSecurityDir();
  const outside = tempSecurityDir();
  const securityDir = path.join(container, 'security');
  const displaced = path.join(container, 'security-original');
  const originalMkdirSync = fs.mkdirSync;
  let swapped = false;
  fs.mkdirSync = ((...args: unknown[]) => {
    const result = Reflect.apply(originalMkdirSync, fs, args);
    if (!swapped && path.resolve(String(args[0])) === path.resolve(securityDir)) {
      fs.renameSync(securityDir, displaced);
      try {
        linkDirectory(outside, securityDir);
      } catch (error) {
        fs.renameSync(displaced, securityDir);
        t.skip(`symlink/junction unavailable: ${String(error)}`);
      }
      swapped = true;
    }
    return result;
  }) as typeof fs.mkdirSync;

  try {
    const error = captureError(() => resolveAtRestProtector(securityDir, {
      credentialProtector,
      fresh: true,
    }));
    assertKeyError(error);
    assert.match(error.message, /symbolic link|junction|reparse|managed directory/i);
  } finally {
    fs.mkdirSync = originalMkdirSync;
    clearAtRestProtectorCache();
  }
  assert.equal(swapped, true, 'test must exercise the post-mkdir directory swap');
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.deepEqual(fs.readdirSync(displaced), []);
});

test('an at-rest keybox symlink is never followed', (t) => {
  const securityDir = tempSecurityDir();
  const outside = tempSecurityDir();
  resolveAtRestProtector(outside, { credentialProtector });
  const outsideKey = atRestKeyPath(outside);
  const outsideBefore = fs.readFileSync(outsideKey);
  try {
    symlinkSync(outsideKey, atRestKeyPath(securityDir), 'file');
  } catch (error) {
    t.skip(`file symlink unavailable: ${String(error)}`);
    return;
  }

  const error = captureError(() => resolveAtRestProtector(securityDir, {
    credentialProtector,
    fresh: true,
  }));
  assertKeyError(error);
  assert.match(error.message, /symbolic link|reparse|managed path|escaped managed directory/i);
  assert.deepEqual(fs.readFileSync(outsideKey), outsideBefore);
  clearAtRestProtectorCache();
});
