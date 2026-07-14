// AES-256-GCM credential protector (host · L0 · security).
// The envelope uses exact canonical base64 parts and permits an empty payload.
import crypto from 'node:crypto';
import type { CredentialProtector } from './credential-store-types.js';

function aesKey(keyMaterial: string): Buffer {
  return crypto.createHash('sha256').update(keyMaterial).digest();
}

function requiredAesKeyMaterial(keyMaterial: unknown): string {
  const material = String(keyMaterial ?? (process.env.ACW_CREDENTIAL_KEY ?? process.env.KCW_CREDENTIAL_KEY) ?? '');
  if (!material.trim()) {
    throw new Error('ACW_CREDENTIAL_KEY is required when DPAPI is unavailable');
  }
  if (Buffer.byteLength(material, 'utf8') < 16) {
    throw new Error('ACW_CREDENTIAL_KEY must contain at least 16 bytes');
  }
  return material;
}

function unsupportedCipherText(): Error {
  return new Error('Unsupported credential cipher text');
}

function canonicalBase64(value: string, expectedBytes?: number): Buffer {
  const decoded = Buffer.from(value, 'base64');
  if (
    decoded.toString('base64') !== value
    || (expectedBytes !== undefined && decoded.length !== expectedBytes)
  ) {
    throw unsupportedCipherText();
  }
  return decoded;
}

/** AES-256-GCM envelope: aesgcm:v1:<12-byte iv>:<16-byte tag>:<ciphertext>. */
export function createAesGcmProtector(
  { keyMaterial }: { keyMaterial?: unknown } = {},
): CredentialProtector {
  const key = aesKey(requiredAesKeyMaterial(keyMaterial));
  return {
    protect(plainText: unknown): string {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return [
        'aesgcm',
        'v1',
        iv.toString('base64'),
        tag.toString('base64'),
        encrypted.toString('base64'),
      ].join(':');
    },
    unprotect(sealedText: unknown): string {
      if (typeof sealedText !== 'string') throw unsupportedCipherText();
      const parts = sealedText.split(':');
      if (parts.length !== 5 || parts[0] !== 'aesgcm' || parts[1] !== 'v1') {
        throw unsupportedCipherText();
      }
      const ivText = parts[2];
      const tagText = parts[3];
      const encryptedText = parts[4];
      if (ivText === undefined || tagText === undefined || encryptedText === undefined) {
        throw unsupportedCipherText();
      }
      const iv = canonicalBase64(ivText, 12);
      const tag = canonicalBase64(tagText, 16);
      const encrypted = canonicalBase64(encryptedText);
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
    },
  };
}
