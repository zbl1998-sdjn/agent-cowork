import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  clearAtRestProtectorCache,
  openAtRest,
  sealAtRest,
} from '../src/security/at-rest.js';
import { createAesGcmProtector } from '../src/security/credential-store.js';

function tempSecurityDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-at-rest-encryption-'));
}

test('a valid keybox isolates alien ciphertext to the single unreadable value', () => {
  const securityDir = tempSecurityDir();
  const credentialProtector = createAesGcmProtector({ keyMaterial: 'test-valid-keybox-kek' });
  const options = {
    credentialProtector,
    env: { KCW_ENCRYPT_AT_REST: '1' },
  };
  try {
    const validCiphertext = sealAtRest('valid-record', securityDir, options);
    const alienCiphertext = createAesGcmProtector({ keyMaterial: 'test-alien-record-dek' })
      .protect('alien-record');

    assert.equal(openAtRest(alienCiphertext, securityDir, options), null);
    assert.equal(openAtRest(validCiphertext, securityDir, options), 'valid-record');
  } finally {
    clearAtRestProtectorCache();
  }
});
