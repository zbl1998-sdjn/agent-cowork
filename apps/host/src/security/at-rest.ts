// 落盘加密信封(host · L1 security · at-rest)
// ---------------------------------------------------------------------------
// 职责:为对话/运行正文等大块本地数据提供"透明落盘加密"。用 DEK(随机数据密钥)做
//       快速 AES-256-GCM 加解密;DEK 本身只被 credential-protector(Windows=DPAPI /
//       其余 AES-GCM)封印一次,存进 <securityDir>/at-rest.key。避免每次写盘都拉
//       PowerShell/DPAPI 的开销,同时把根密钥交给 OS(DPAPI)或环境派生密钥托管。
// 依赖:node:crypto/fs/path + L0 credential-store(KEK 与 isSealedCredential)+ confidential。
// 语义:写侧按开关加密(未开则明文,便于渐进启用);读侧永远透明——密文解开、遗留
//       明文透传、开不了的密文(换机器/换用户/轮换密钥)返回 null 交调用方按损坏跳过。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  createAesGcmProtector,
  createDefaultCredentialProtector,
  isSealedCredential,
  type CredentialProtector,
} from './credential-store.js';
import { resolveSecurityMode, type RuntimeEnv, type SecurityMode } from './security-mode.js';

export type AtRestEnv = Record<string, string | undefined>;
export type AtRestOptions = { credentialProtector?: CredentialProtector; env?: AtRestEnv; fresh?: boolean };

const TRUTHY = new Set(['1', 'true', 'on', 'yes']);
const FALSY = new Set(['0', 'false', 'off', 'no']);

// 落盘加密默认策略跟随实际安全档位。运行时 securityMode 可由 config(而非仅 env)决定,而 stores
// 落盘时无 config 上下文;故 server 启动期用权威解析(含 config)注入此进程级覆盖,env 解析兜底。
let atRestModeOverride: SecurityMode | null = null;

/** 启动期注入权威 securityMode(含 config),让落盘加密默认策略与实际档位一致。传 null 清除。 */
export function setAtRestSecurityMode(mode: SecurityMode | null): void {
  atRestModeOverride = mode;
}

function effectiveSecurityMode(env: AtRestEnv): SecurityMode {
  return atRestModeOverride ?? resolveSecurityMode({ env: env as RuntimeEnv });
}

/**
 * 落盘加密是否开启(按档绑定的加固默认策略):
 * - air_gap(含机密总开关):强制开,显式 KCW_ENCRYPT_AT_REST=0 也不削弱(fail-closed);
 * - local_strict / enterprise_local:默认开,可用 KCW_ENCRYPT_AT_REST=0/off/false/no 关;
 * - local_demo / controlled_hybrid(标准档):默认关,可用 KCW_ENCRYPT_AT_REST=1 开。
 */
export function isAtRestEncryptionEnabled(env: AtRestEnv = process.env): boolean {
  const mode = effectiveSecurityMode(env);
  if (mode === 'air_gap') return true; // 隔离档:不可削弱
  const raw = String(env.KCW_ENCRYPT_AT_REST ?? '').trim().toLowerCase();
  if (TRUTHY.has(raw)) return true; // 显式开(任意档)
  if (FALSY.has(raw)) return false; // 显式关(air_gap 之外)
  return mode === 'local_strict' || mode === 'enterprise_local'; // 本地严格/企业内网默认开
}

export function atRestKeyPath(securityDir: string): string {
  return path.join(securityDir, 'at-rest.key');
}

// 按 securityDir 缓存 DEK protector:进程内只解一次密钥箱(首用一次 KEK 调用)。
const protectorCache = new Map<string, CredentialProtector>();

function kekFor(options: AtRestOptions): CredentialProtector {
  return options.credentialProtector || createDefaultCredentialProtector();
}

/** 载入或创建 <securityDir>/at-rest.key(被 KEK 封印的随机 DEK),返回以 DEK 为密钥的 AES-GCM protector。 */
export function resolveAtRestProtector(securityDir: string, options: AtRestOptions = {}): CredentialProtector {
  const keyFile = atRestKeyPath(securityDir);
  if (!options.fresh) {
    const cached = protectorCache.get(keyFile);
    if (cached) return cached;
  }
  const kek = kekFor(options);
  let dekHex: string | null = null;
  if (fs.existsSync(keyFile)) {
    try {
      const sealed = fs.readFileSync(keyFile, 'utf8').trim();
      if (isSealedCredential(sealed)) dekHex = kek.unprotect(sealed);
    } catch {
      dekHex = null; // 密钥箱开不了(换机器/换用户):按无密钥处理,下面重建(旧密文将不可读——本地加密的固有代价)。
    }
  }
  if (!dekHex) {
    dekHex = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(securityDir, { recursive: true });
    const tmp = `${keyFile}.tmp`;
    fs.writeFileSync(tmp, kek.protect(dekHex), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, keyFile);
  }
  const protector = createAesGcmProtector({ keyMaterial: dekHex });
  protectorCache.set(keyFile, protector);
  return protector;
}

/** 写侧:开关开则用 DEK 封印 plainText,否则原样返回(渐进启用/迁移友好)。 */
export function sealAtRest(plainText: string, securityDir: string, options: AtRestOptions = {}): string {
  if (!isAtRestEncryptionEnabled(options.env ?? process.env)) return plainText;
  return resolveAtRestProtector(securityDir, options).protect(plainText);
}

/** 读侧:密文用 DEK 解开(失败返回 null);非密文按遗留明文透传。 */
export function openAtRest(text: string, securityDir: string, options: AtRestOptions = {}): string | null {
  if (!isSealedCredential(text)) return text;
  try {
    return resolveAtRestProtector(securityDir, options).unprotect(text);
  } catch {
    return null;
  }
}

/** 供测试清缓存(密钥箱轮换后重解)。 */
export function clearAtRestProtectorCache(): void {
  protectorCache.clear();
}
