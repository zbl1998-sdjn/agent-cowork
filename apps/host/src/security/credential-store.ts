// 凭据加密存储(host · L0 基础层,无内部依赖)
// ---------------------------------------------------------------------------
// 职责:把第三方连接器(如 GitHub)OAuth 等机密「加密落盘」,只在内存中按需解密,
//       并对外只暴露脱敏摘要(summary)。绝不把明文写日志或入库(plan/01 D.12)。
// 加密器(Protector,可注入):
//   · Windows → DPAPI(CurrentUser 作用域,密钥随用户/机器绑定);
//   · 其他平台 → AES-256-GCM(密钥取自环境或 主机名:用户名:home 派生)。
// 文件权限:0o600(仅属主可读写)。键 = tenant/user/provider/account 四元组。
// 导出:createAesGcmProtector / createDpapiProtector / createDefaultCredentialProtector
//       / createCredentialStore。

import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { summarizeCredential } from './credential-summary.js';
import type {
  CredentialEntry,
  CredentialFile,
  CredentialFilter,
  CredentialIdentity,
  CredentialProtector,
  CredentialStore,
  CredentialStoreOptions,
  CredentialSummary,
} from './credential-store-types.js';

export type {
  CredentialEntry,
  CredentialFile,
  CredentialFilter,
  CredentialIdentity,
  CredentialProtector,
  CredentialStore,
  CredentialStoreOptions,
  CredentialSummary,
} from './credential-store-types.js';

function ensureDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function safePart(value: unknown, fallback: unknown): string {
  const text = String(value || fallback || '').trim();
  if (!text) throw new Error('credential identity contains an empty key part');
  return encodeURIComponent(text);
}

/** 由身份四元组拼出存储键 `tenant/user/provider/account`(各段 URL 编码,空段报错)。 */
function credentialKey(identity: CredentialIdentity): string {
  return [
    safePart(identity.tenantId, 'tenant_local'),
    safePart(identity.userId, 'user_local'),
    safePart(identity.provider, ''),
    safePart(identity.accountId, 'default'),
  ].join('/');
}

/** 读取存储文件;不存在则返回空库(容错:损坏的 entries 字段退化为空)。 */
function readStore(filePath: string): CredentialFile {
  if (!fs.existsSync(filePath)) {
    return { schemaVersion: 1, entries: {} };
  }
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const record = (data || {}) as { entries?: unknown };
  return {
    schemaVersion: 1,
    entries: record.entries && typeof record.entries === 'object'
      ? record.entries as Record<string, CredentialEntry>
      : {},
  };
}

/** 写回存储文件,权限收紧到 0o600(仅属主可读写)。 */
function writeStore(filePath: string, data: CredentialFile): void {
  ensureDir(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function entriesWithoutKey(entries: Record<string, CredentialEntry>, keyToRemove: string): Record<string, CredentialEntry> {
  const { [keyToRemove]: _removed, ...remaining } = entries;
  return remaining;
}

function aesKey(keyMaterial: unknown): Buffer {
  return crypto.createHash('sha256').update(String(keyMaterial || '')).digest();
}

/** 造 AES-256-GCM 加密器(跨平台兜底):密文形如 `aesgcm:v1:iv:tag:data`,自带完整性校验。 */
export function createAesGcmProtector({ keyMaterial }: { keyMaterial?: unknown } = {}): CredentialProtector {
  const key = aesKey(keyMaterial || process.env.KCW_CREDENTIAL_KEY || `${os.hostname()}:${os.userInfo().username}:${os.homedir()}`);
  return {
    protect(plainText: unknown): string {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return `aesgcm:v1:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
    },
    unprotect(sealedText: unknown): string {
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

function powershellPath(): string {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const windowsPowerShell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return fs.existsSync(windowsPowerShell) ? windowsPowerShell : 'powershell.exe';
}

/** 调 PowerShell 执行 DPAPI 加解密脚本,经 stdin 传 base64 输入(5s 超时、隐藏窗口)。 */
function runDpapi(script: string, base64Input: string): string {
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

/** 造 Windows DPAPI 加密器:密钥由当前用户账户保管,密文形如 `dpapi:v1:...`。 */
export function createDpapiProtector(): CredentialProtector {
  const scope = '[System.Security.Cryptography.DataProtectionScope]::CurrentUser';
  return {
    protect(plainText: unknown): string {
      const script = `$b=[Convert]::FromBase64String(([Console]::In.ReadToEnd()).Trim());$e=[System.Security.Cryptography.ProtectedData]::Protect($b,$null,${scope});[Convert]::ToBase64String($e)`;
      const sealed = runDpapi(script, Buffer.from(String(plainText), 'utf8').toString('base64'));
      return `dpapi:v1:${sealed}`;
    },
    unprotect(sealedText: unknown): string {
      const text = String(sealedText || '');
      if (!text.startsWith('dpapi:v1:')) throw new Error('Unsupported credential cipher text');
      const script = `$b=[Convert]::FromBase64String(([Console]::In.ReadToEnd()).Trim());$d=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,${scope});[Convert]::ToBase64String($d)`;
      const plainBase64 = runDpapi(script, text.slice('dpapi:v1:'.length));
      return Buffer.from(plainBase64, 'base64').toString('utf8');
    },
  };
}

/** 按平台选默认加密器:Windows 用 DPAPI,其余用 AES-GCM。 */
export function createDefaultCredentialProtector(): CredentialProtector {
  if (process.platform === 'win32') return createDpapiProtector();
  return createAesGcmProtector();
}

/**
 * 造凭据存储:提供 put/get/list/delete/deleteMany。
 * 写入时密钥经 protector 加密成 sealed 落盘;list 只返回脱敏 summary,get 才解密还原明文。
 */
export function createCredentialStore({ filePath, protector = createDefaultCredentialProtector() }: CredentialStoreOptions = {}): CredentialStore {
  if (!filePath) throw new Error('createCredentialStore: filePath is required');
  return {
    /** 存入/覆盖一条凭据:明文加密为 sealed,同时保存脱敏 summary。 */
    put(identity: CredentialIdentity, secret: Record<string, unknown>): CredentialSummary {
      const key = credentialKey(identity);
      const data = readStore(filePath);
      const summary = summarizeCredential(identity, secret || {});
      data.entries[key] = {
        summary,
        sealed: protector.protect(JSON.stringify(secret || {})),
      };
      writeStore(filePath, data);
      return { ...summary };
    },
    /** 取出并解密一条凭据明文;不存在返回 null。 */
    get(identity: CredentialIdentity): Record<string, unknown> | null {
      const data = readStore(filePath);
      const entry = data.entries[credentialKey(identity)];
      if (!entry) return null;
      return JSON.parse(protector.unprotect(entry.sealed)) as Record<string, unknown>;
    },
    /** 列出匹配过滤条件的脱敏摘要(不解密、不含密钥)。 */
    list(filter: CredentialFilter = {}): CredentialSummary[] {
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
    /** 删除单条凭据;返回是否确有删除。 */
    delete(identity: CredentialIdentity): boolean {
      const key = credentialKey(identity);
      const data = readStore(filePath);
      const existed = Boolean(data.entries[key]);
      data.entries = entriesWithoutKey(data.entries, key);
      if (existed) writeStore(filePath, data);
      return existed;
    },
    /** 批量删除匹配过滤条件的凭据;返回删除条数(如撤销某租户某 provider 的全部授权)。 */
    deleteMany(filter: CredentialFilter = {}): number {
      const data = readStore(filePath);
      let removed = 0;
      const nextEntries: Record<string, CredentialEntry> = {};
      for (const [key, entry] of Object.entries(data.entries)) {
        const s = entry.summary || {};
        const matches = !(filter.tenantId && s.tenantId !== filter.tenantId)
          && !(filter.userId && s.userId !== filter.userId)
          && !(filter.provider && s.provider !== filter.provider);
        if (matches) {
          removed += 1;
        } else {
          nextEntries[key] = entry;
        }
      }
      data.entries = nextEntries;
      if (removed) writeStore(filePath, data);
      return removed;
    },
  };
}
