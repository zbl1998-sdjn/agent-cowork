// 凭据加密存储(host · L0 基础层,无内部依赖)
// ---------------------------------------------------------------------------
// 职责:把第三方连接器(如 GitHub)OAuth 等机密「加密落盘」,只在内存中按需解密,
//       并对外只暴露脱敏摘要(summary)。绝不把明文写日志或入库(plan/01 D.12)。
// 加密器(Protector,可注入):
//   · Windows → DPAPI(CurrentUser 作用域,密钥随用户/机器绑定);
//   · 其他平台 → AES-256-GCM(必须显式传入密钥或设置 KCW_CREDENTIAL_KEY)。
// 文件权限:0o600(仅属主可读写)。键 = tenant/user/provider/account 四元组。
// 导出:createAesGcmProtector / createDpapiProtector / createDefaultCredentialProtector
//       / createCredentialStore / isSealedCredential。

import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createAesGcmProtector } from './credential-aes.js';
import {
  canonicalCredentialFilter,
  canonicalCredentialIdentity,
  credentialIdentityTupleKey,
  legacyCredentialIdentityKey,
  type CanonicalCredentialFilter,
} from './credential-identity.js';
import { credentialAtIdentity, migrateLegacyCredentialKeys } from './credential-key-migration.js';
import {
  assertCredentialEntriesWritable,
  createCredentialDiskFileOperation,
  credentialEntriesWithoutKey,
  credentialSummaryDto,
  decodeStoredCredentialEntry,
  parseCredentialPayload,
  readCredentialDiskFile,
  readCredentialDiskFileForWrite,
  serializeCredentialPayload,
  writeCredentialDiskFile,
} from './credential-persistence.js';
import { summarizeCredential } from './credential-summary.js';
import type {
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
export { createAesGcmProtector } from './credential-aes.js';

function summaryMatches(summary: CredentialSummary, filter: CanonicalCredentialFilter): boolean {
  if (filter.tenantId !== undefined && summary.tenantId !== filter.tenantId) return false;
  if (filter.userId !== undefined && summary.userId !== filter.userId) return false;
  if (filter.provider !== undefined && summary.provider !== filter.provider) return false;
  return filter.accountId === undefined || summary.accountId === filter.accountId;
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
  // Windows PowerShell 5.1(.NET Framework)默认不加载 System.Security,直接引用
  // [System.Security.Cryptography.ProtectedData] 会 TypeNotFound;必须先 Add-Type。
  // PowerShell 7(.NET)已内置,重复 Add-Type 无害。
  const preamble = 'Add-Type -AssemblyName System.Security;';
  return {
    protect(plainText: unknown): string {
      const script = `${preamble}$b=[Convert]::FromBase64String(([Console]::In.ReadToEnd()).Trim());$e=[System.Security.Cryptography.ProtectedData]::Protect($b,$null,${scope});[Convert]::ToBase64String($e)`;
      const sealed = runDpapi(script, Buffer.from(String(plainText), 'utf8').toString('base64'));
      return `dpapi:v1:${sealed}`;
    },
    unprotect(sealedText: unknown): string {
      const text = String(sealedText || '');
      if (!text.startsWith('dpapi:v1:')) throw new Error('Unsupported credential cipher text');
      const script = `${preamble}$b=[Convert]::FromBase64String(([Console]::In.ReadToEnd()).Trim());$d=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,${scope});[Convert]::ToBase64String($d)`;
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

/** 判断文本是否已是 protector 封印格式(dpapi:v1:/aesgcm:v1:),供读侧兼容明文遗留数据。 */
export function isSealedCredential(value: unknown): boolean {
  const text = String(value || '');
  return text.startsWith('dpapi:v1:') || text.startsWith('aesgcm:v1:');
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
      const canonical = canonicalCredentialIdentity(identity);
      const key = credentialIdentityTupleKey(canonical);
      const serialized = serializeCredentialPayload(secret);
      const payload = parseCredentialPayload(serialized);
      const summary = credentialSummaryDto(summarizeCredential(canonical, payload));
      if (!summary) throw new Error('credential summary DTO is invalid');
      const operation = createCredentialDiskFileOperation(filePath);
      const data = readCredentialDiskFileForWrite(filePath, operation);
      assertCredentialEntriesWritable(data.entries);
      const sealed = protector.protect(serialized);
      data.entries = credentialEntriesWithoutKey(data.entries, legacyCredentialIdentityKey(canonical));
      data.entries[key] = {
        summary,
        sealed,
      };
      writeCredentialDiskFile(filePath, data, operation);
      return { ...summary };
    },
    /** 取出并解密一条凭据明文;不存在返回 null。 */
    get(identity: CredentialIdentity): Record<string, unknown> | null {
      const canonical = canonicalCredentialIdentity(identity);
      const operation = createCredentialDiskFileOperation(filePath);
      const data = readCredentialDiskFile(filePath, operation);
      const lookup = credentialAtIdentity(data.entries, canonical);
      if (!lookup.entry) return null;
      try {
        const payload = parseCredentialPayload(protector.unprotect(lookup.entry.sealed));
        if (lookup.changed) {
          assertCredentialEntriesWritable(data.entries);
          data.entries = lookup.entries;
          writeCredentialDiskFile(filePath, data, operation);
        }
        return payload;
      } catch {
        throw new Error('credential payload is corrupt or invalid');
      }
    },
    /** 列出匹配过滤条件的脱敏摘要(不解密、不含密钥)。 */
    list(filter: CredentialFilter = {}): CredentialSummary[] {
      const canonicalFilter = canonicalCredentialFilter(filter);
      const operation = createCredentialDiskFileOperation(filePath);
      const data = readCredentialDiskFile(filePath, operation);
      const migration = migrateLegacyCredentialKeys(data.entries);
      const summaries = Object.entries(migration.entries).flatMap(([key, value]) => {
        const entry = decodeStoredCredentialEntry(key, value);
        const summary = entry ? credentialSummaryDto(entry.summary) : null;
        return summary && summaryMatches(summary, canonicalFilter) ? [summary] : [];
      });
      if (migration.changed) {
        assertCredentialEntriesWritable(data.entries);
        data.entries = migration.entries;
        writeCredentialDiskFile(filePath, data, operation);
      }
      return summaries;
    },
    /** 删除单条凭据;返回是否确有删除。 */
    delete(identity: CredentialIdentity): boolean {
      const canonical = canonicalCredentialIdentity(identity);
      const key = credentialIdentityTupleKey(canonical);
      const legacyKey = legacyCredentialIdentityKey(canonical);
      const operation = createCredentialDiskFileOperation(filePath);
      const data = readCredentialDiskFile(filePath, operation);
      const existed = Object.hasOwn(data.entries, key) || Object.hasOwn(data.entries, legacyKey);
      data.entries = credentialEntriesWithoutKey(data.entries, key);
      data.entries = credentialEntriesWithoutKey(data.entries, legacyKey);
      if (existed) {
        const writable = readCredentialDiskFileForWrite(filePath, operation);
        writable.entries = credentialEntriesWithoutKey(writable.entries, key);
        writable.entries = credentialEntriesWithoutKey(writable.entries, legacyKey);
        assertCredentialEntriesWritable(writable.entries);
        writeCredentialDiskFile(filePath, writable, operation);
      }
      return existed;
    },
    /** 批量删除匹配过滤条件的凭据;返回删除条数(如撤销某租户某 provider 的全部授权)。 */
    deleteMany(filter: CredentialFilter = {}): number {
      const canonicalFilter = canonicalCredentialFilter(filter);
      const operation = createCredentialDiskFileOperation(filePath);
      const data = readCredentialDiskFile(filePath, operation);
      const identities = new Map<string, CredentialSummary>();
      for (const [key, value] of Object.entries(data.entries)) {
        const entry = decodeStoredCredentialEntry(key, value);
        const matches = Boolean(entry && summaryMatches(entry.summary, canonicalFilter));
        if (entry && matches) identities.set(credentialIdentityTupleKey(entry.summary), entry.summary);
      }
      let nextEntries = data.entries;
      for (const identity of identities.values()) {
        nextEntries = credentialEntriesWithoutKey(nextEntries, credentialIdentityTupleKey(identity));
        nextEntries = credentialEntriesWithoutKey(nextEntries, legacyCredentialIdentityKey(identity));
      }
      const removed = identities.size;
      data.entries = nextEntries;
      if (removed) {
        const writable = readCredentialDiskFileForWrite(filePath, operation);
        let writableEntries = writable.entries;
        for (const identity of identities.values()) {
          writableEntries = credentialEntriesWithoutKey(writableEntries, credentialIdentityTupleKey(identity));
          writableEntries = credentialEntriesWithoutKey(writableEntries, legacyCredentialIdentityKey(identity));
        }
        writable.entries = writableEntries;
        assertCredentialEntriesWritable(writable.entries);
        writeCredentialDiskFile(filePath, writable, operation);
      }
      return removed;
    },
  };
}
