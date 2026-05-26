import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * @typedef {{ tenantId?: unknown, userId?: unknown, provider?: unknown, accountId?: unknown }} CredentialIdentity
 * @typedef {{ provider: string, accountId: string, tenantId: string, userId: string, scopes: string[], account: Record<string, unknown> | null, updatedAt: string }} CredentialSummary
 * @typedef {{ summary: CredentialSummary, sealed: string }} CredentialEntry
 * @typedef {{ schemaVersion: number, entries: Record<string, CredentialEntry> }} CredentialFile
 * @typedef {{ protect(plainText: unknown): string, unprotect(sealedText: unknown): string }} CredentialProtector
 * @typedef {{ filePath?: string, protector?: CredentialProtector }} CredentialStoreOptions
 * @typedef {{ tenantId?: unknown, userId?: unknown, provider?: unknown, accountId?: unknown }} CredentialFilter
 */

/** @param {string} filePath */
function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

/** @param {unknown} value @param {unknown} fallback */
function safePart(value, fallback) {
  const text = String(value || fallback || '').trim();
  if (!text) throw new Error('credential identity contains an empty key part');
  return encodeURIComponent(text);
}

/** @param {CredentialIdentity} identity */
function credentialKey(identity) {
  return [
    safePart(identity.tenantId, 'tenant_local'),
    safePart(identity.userId, 'user_local'),
    safePart(identity.provider, ''),
    safePart(identity.accountId, 'default'),
  ].join('/');
}

/** @param {string} filePath @returns {CredentialFile} */
function readStore(filePath) {
  if (!fs.existsSync(filePath)) {
    return { schemaVersion: 1, entries: {} };
  }
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const record = /** @type {{ entries?: unknown }} */ (data || {});
  return {
    schemaVersion: 1,
    entries: record.entries && typeof record.entries === 'object'
      ? /** @type {Record<string, CredentialEntry>} */ (record.entries)
      : {},
  };
}

/** @param {string} filePath @param {CredentialFile} data */
function writeStore(filePath, data) {
  ensureDir(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

/** @param {Record<string, unknown>} value */
function scopesFrom(value) {
  if (Array.isArray(value.scopes)) {
    return value.scopes.map(String).map((s) => s.trim()).filter(Boolean);
  }
  return String(value.scope || '').split(/\s+/).map((s) => s.trim()).filter(Boolean);
}

/** @param {unknown} account @returns {Record<string, unknown> | null} */
function safeAccount(account) {
  if (!account || typeof account !== 'object') return null;
  const source = /** @type {Record<string, unknown>} */ (account);
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const key of ['login', 'id', 'name', 'email']) {
    if (source[key] !== undefined && source[key] !== null) out[key] = source[key];
  }
  return Object.keys(out).length ? out : null;
}

/** @param {CredentialIdentity} identity @param {Record<string, unknown>} secret @returns {CredentialSummary} */
function summarize(identity, secret) {
  const account = safeAccount(secret.account);
  return {
    provider: String(identity.provider),
    accountId: String(identity.accountId || account?.login || 'default'),
    tenantId: String(identity.tenantId || 'tenant_local'),
    userId: String(identity.userId || 'user_local'),
    scopes: scopesFrom(secret),
    account,
    updatedAt: new Date().toISOString(),
  };
}

/** @param {unknown} keyMaterial */
function aesKey(keyMaterial) {
  return crypto.createHash('sha256').update(String(keyMaterial || '')).digest();
}

/** @param {{ keyMaterial?: unknown }} [options] @returns {CredentialProtector} */
export function createAesGcmProtector({ keyMaterial } = {}) {
  const key = aesKey(keyMaterial || process.env.KCW_CREDENTIAL_KEY || `${os.hostname()}:${os.userInfo().username}:${os.homedir()}`);
  return {
    protect(plainText) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return `aesgcm:v1:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
    },
    unprotect(sealedText) {
      const parts = String(sealedText || '').split(':');
      if (parts[0] !== 'aesgcm' || parts[1] !== 'v1' || parts.length !== 5) {
        throw new Error('Unsupported credential cipher text');
      }
      const [, , ivText, tagText, encryptedText] = parts;
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivText, 'base64'));
      decipher.setAuthTag(Buffer.from(tagText, 'base64'));
      return Buffer.concat([
        decipher.update(Buffer.from(encryptedText, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    },
  };
}

function powershellPath() {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const windowsPowerShell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return fs.existsSync(windowsPowerShell) ? windowsPowerShell : 'powershell.exe';
}

/** @param {string} script @param {string} base64Input */
function runDpapi(script, base64Input) {
  const output = childProcess.execFileSync(powershellPath(), [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    script,
  ], {
    input: base64Input,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5000,
  });
  return String(output).trim();
}

/** @returns {CredentialProtector} */
export function createDpapiProtector() {
  const scope = '[System.Security.Cryptography.DataProtectionScope]::CurrentUser';
  return {
    protect(plainText) {
      const script = `$b=[Convert]::FromBase64String(([Console]::In.ReadToEnd()).Trim());$e=[System.Security.Cryptography.ProtectedData]::Protect($b,$null,${scope});[Convert]::ToBase64String($e)`;
      const sealed = runDpapi(script, Buffer.from(String(plainText), 'utf8').toString('base64'));
      return `dpapi:v1:${sealed}`;
    },
    unprotect(sealedText) {
      const text = String(sealedText || '');
      if (!text.startsWith('dpapi:v1:')) throw new Error('Unsupported credential cipher text');
      const script = `$b=[Convert]::FromBase64String(([Console]::In.ReadToEnd()).Trim());$d=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,${scope});[Convert]::ToBase64String($d)`;
      const plainBase64 = runDpapi(script, text.slice('dpapi:v1:'.length));
      return Buffer.from(plainBase64, 'base64').toString('utf8');
    },
  };
}

/** @returns {CredentialProtector} */
export function createDefaultCredentialProtector() {
  if (process.platform === 'win32') return createDpapiProtector();
  return createAesGcmProtector();
}

/** @param {CredentialStoreOptions} [options] */
export function createCredentialStore({ filePath, protector = createDefaultCredentialProtector() } = {}) {
  if (!filePath) throw new Error('createCredentialStore: filePath is required');
  return {
    /** @param {CredentialIdentity} identity @param {Record<string, unknown>} secret */
    put(identity, secret) {
      const key = credentialKey(identity);
      const data = readStore(filePath);
      const summary = summarize(identity, secret || {});
      data.entries[key] = {
        summary,
        sealed: protector.protect(JSON.stringify(secret || {})),
      };
      writeStore(filePath, data);
      return { ...summary };
    },
    /** @param {CredentialIdentity} identity */
    get(identity) {
      const data = readStore(filePath);
      const entry = data.entries[credentialKey(identity)];
      if (!entry) return null;
      return JSON.parse(protector.unprotect(entry.sealed));
    },
    /** @param {CredentialFilter} [filter] */
    list(filter = {}) {
      const data = readStore(filePath);
      return Object.entries(data.entries)
        .filter(([, entry]) => {
          const s = entry.summary || {};
          if (filter.tenantId && s.tenantId !== filter.tenantId) return false;
          if (filter.userId && s.userId !== filter.userId) return false;
          if (filter.provider && s.provider !== filter.provider) return false;
          return !(filter.accountId && s.accountId !== filter.accountId);
        })
        .map(([, entry]) => ({ ...(entry.summary || {}) }));
    },
    /** @param {CredentialIdentity} identity */
    delete(identity) {
      const key = credentialKey(identity);
      const data = readStore(filePath);
      const existed = Boolean(data.entries[key]);
      delete data.entries[key];
      if (existed) writeStore(filePath, data);
      return existed;
    },
    /** @param {CredentialFilter} [filter] */
    deleteMany(filter = {}) {
      const data = readStore(filePath);
      let removed = 0;
      for (const [key, entry] of Object.entries(data.entries)) {
        const s = entry.summary || {};
        if (filter.tenantId && s.tenantId !== filter.tenantId) continue;
        if (filter.userId && s.userId !== filter.userId) continue;
        if (filter.provider && s.provider !== filter.provider) continue;
        delete data.entries[key];
        removed += 1;
      }
      if (removed) writeStore(filePath, data);
      return removed;
    },
  };
}
