// 落盘加密信封(host · L1 security · at-rest):用 AES-256-GCM DEK 透明保护本地大块数据，
// DEK 经 credential-protector 封印至 <securityDir>/at-rest.key，并复用 L0 稳定目录边界。
// 写侧按开关加密、读侧兼容明文；单条认证失败返回 null，密钥基础设施失败抛 typed error。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  createAesGcmProtector,
  createDefaultCredentialProtector,
  isSealedCredential,
  type CredentialProtector,
} from './credential-store.js';
import { createManagedDirectoryBoundary, type ManagedDirectoryBoundary } from './managed-directory-boundary.js';
import { resolveSecurityMode, type RuntimeEnv, type SecurityMode } from './security-mode.js';

export type AtRestEnv = Record<string, string | undefined>;
export type AtRestOptions = { credentialProtector?: CredentialProtector; env?: AtRestEnv;
  fresh?: boolean; createIfMissing?: boolean };
export class AtRestKeyError extends Error {
  readonly code = 'AT_REST_KEY_ERROR' as const;
  readonly statusCode = 500;
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AtRestKeyError';
  }
}
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
/** 档位绑定策略：air_gap 强制开；strict/enterprise 默认开；demo/hybrid 默认关；非 air_gap 可显式覆盖。 */
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

type CachedProtector = Readonly<{ keyboxText: string; protector: CredentialProtector }>;

// 缓存与密钥箱原文绑定；每次命中都复核文件仍存在且未改变，避免清除密钥后继续用陈旧 DEK。
const protectorCache = new Map<string, CachedProtector>();

function kekFor(options: AtRestOptions): CredentialProtector {
  return options.credentialProtector || createDefaultCredentialProtector();
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null
    && (error as { code?: unknown }).code === code;
}

function keyError(message: string, cause?: unknown): AtRestKeyError {
  if (cause instanceof AtRestKeyError) return cause;
  const detail = cause instanceof Error && cause.message ? `: ${cause.message}` : '';
  return new AtRestKeyError(`${message}${detail}`, { cause });
}

function boundaryFor(securityDir: string, create: boolean): ManagedDirectoryBoundary | null {
  try {
    return createManagedDirectoryBoundary(securityDir, { create, label: 'At-rest key directory' });
  } catch (error) {
    if (!create && hasErrorCode(error, 'ENOENT')) return null;
    throw keyError('at-rest security directory is unavailable or unsafe', error);
  }
}

function inspectFile(boundary: ManagedDirectoryBoundary, file: string, allowMissing: boolean): void {
  boundary.inspectPath(file, { allowMissing, kind: 'file' });
}
function guardedFileOp<T>(boundary: ManagedDirectoryBoundary, file: string, operation: () => T,
  beforeMissing = false, afterMissing = false): T {
  inspectFile(boundary, file, beforeMissing);
  const result = operation();
  inspectFile(boundary, file, afterMissing);
  return result;
}
function readKeyboxText(keyFile: string, boundary: ManagedDirectoryBoundary): string | null {
  try {
    const before = boundary.inspectPath(keyFile, { allowMissing: true, kind: 'file' });
    if (!before) return null;
    const keyboxText = fs.readFileSync(before.canonicalPath, 'utf8');
    boundary.revalidatePath(keyFile, before, { kind: 'file' });
    return keyboxText;
  } catch (error) {
    throw keyError('at-rest key file cannot be read', error);
  }
}

function loadKeybox(keyboxText: string, kek: CredentialProtector,
  expectedDek?: string): CachedProtector {
  const sealed = keyboxText.trim();
  if (!isSealedCredential(sealed)) {
    throw keyError('at-rest key file is corrupt or uses an unsupported format');
  }
  let dekHex: string;
  try {
    dekHex = kek.unprotect(sealed);
  } catch (error) {
    throw keyError('at-rest key file is corrupt or cannot be decrypted', error);
  }
  if (!/^[a-f0-9]{64}$/u.test(dekHex)) {
    throw keyError('at-rest key file contains an invalid data key');
  }
  if (expectedDek !== undefined && dekHex !== expectedDek) {
    throw keyError('at-rest credential protector failed its data-key round trip');
  }
  try {
    return {
      keyboxText,
      protector: createAesGcmProtector({ keyMaterial: dekHex }),
    };
  } catch (error) {
    throw keyError('at-rest data key cannot initialize its protector', error);
  }
}

function publishKeybox(keyFile: string, keyboxText: string, boundary: ManagedDirectoryBoundary): boolean {
  let temporaryFile = '';
  let descriptor: number | null = null;
  let ownsTemporaryFile = false;
  let published = false;
  try {
    temporaryFile = `${keyFile}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    inspectFile(boundary, temporaryFile, true);
    descriptor = fs.openSync(temporaryFile, 'wx', 0o600);
    ownsTemporaryFile = true;
    inspectFile(boundary, temporaryFile, false);
    const write = fs.writeFileSync as unknown as (target: number, content: string, encoding: string) => void;
    guardedFileOp(boundary, temporaryFile, () => write(descriptor as number, keyboxText, 'utf8'));
    guardedFileOp(boundary, temporaryFile, () => fs.fsyncSync(descriptor as number));
    guardedFileOp(boundary, temporaryFile, () => fs.closeSync(descriptor as number));
    descriptor = null;
    inspectFile(boundary, temporaryFile, false);
    inspectFile(boundary, keyFile, true);
    try {
      const linkSync = (fs as unknown as { linkSync(source: string, destination: string): void }).linkSync;
      linkSync(temporaryFile, keyFile);
      published = true;
    } catch (error) {
      if (!hasErrorCode(error, 'EEXIST')) throw error;
    }
    inspectFile(boundary, temporaryFile, false);
    inspectFile(boundary, keyFile, false);
  } catch (error) {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch { /* preserve the original publish error */ }
    }
    if (ownsTemporaryFile) {
      try {
        guardedFileOp(boundary, temporaryFile, () => fs.unlinkSync(temporaryFile), false, true);
      } catch { /* preserve the original publish error */ }
    }
    throw keyError('at-rest keybox could not be published', error);
  }
  try {
    guardedFileOp(boundary, temporaryFile, () => fs.unlinkSync(temporaryFile), false, true);
  } catch (error) {
    throw keyError('at-rest keybox temporary file could not be removed', error);
  }
  return published;
}

/** 载入或创建 <securityDir>/at-rest.key(被 KEK 封印的随机 DEK),返回以 DEK 为密钥的 AES-GCM protector。 */
export function resolveAtRestProtector(securityDir: string, options: AtRestOptions = {}): CredentialProtector {
  const resolvedSecurityDir = path.resolve(securityDir);
  const keyFile = atRestKeyPath(resolvedSecurityDir);
  let boundary = boundaryFor(resolvedSecurityDir, false);
  const existingKeybox = boundary ? readKeyboxText(keyFile, boundary) : null;
  if (!options.fresh) {
    const cached = protectorCache.get(keyFile);
    if (cached) {
      if (existingKeybox === cached.keyboxText) return cached.protector;
      protectorCache.delete(keyFile);
    }
  }
  let kek: CredentialProtector;
  try {
    kek = kekFor(options);
  } catch (error) {
    throw keyError('at-rest credential protector is unavailable', error);
  }
  if (existingKeybox !== null) {
    const loaded = loadKeybox(existingKeybox, kek);
    protectorCache.set(keyFile, loaded);
    return loaded.protector;
  }
  if (options.createIfMissing === false) throw keyError('at-rest key file is missing');

  let candidateDek: string;
  let candidateKeybox: string;
  try {
    candidateDek = crypto.randomBytes(32).toString('hex');
    candidateKeybox = kek.protect(candidateDek);
  } catch (error) {
    throw keyError('at-rest data key could not be generated or wrapped', error);
  }
  const candidate = loadKeybox(candidateKeybox, kek, candidateDek);
  boundary ||= boundaryFor(resolvedSecurityDir, true);
  if (!boundary) throw keyError('at-rest security directory could not be established');
  if (publishKeybox(keyFile, candidateKeybox, boundary)) {
    protectorCache.set(keyFile, candidate);
    return candidate.protector;
  }

  const winnerKeybox = readKeyboxText(keyFile, boundary);
  if (winnerKeybox === null) throw keyError('at-rest key file disappeared during creation');
  const winner = loadKeybox(winnerKeybox, kek);
  protectorCache.set(keyFile, winner);
  return winner.protector;
}

/** 写侧:开关开则用 DEK 封印 plainText,否则原样返回(渐进启用/迁移友好)。 */
export function sealAtRest(plainText: string, securityDir: string, options: AtRestOptions = {}): string {
  if (!isAtRestEncryptionEnabled(options.env ?? process.env)) return plainText;
  return resolveAtRestProtector(securityDir, options).protect(plainText);
}

/** 读侧:单条密文认证失败返回 null；密钥基础设施失败抛 AtRestKeyError；明文透传。 */
export function openAtRest(text: string, securityDir: string, options: AtRestOptions = {}): string | null {
  if (!isSealedCredential(text)) return text;
  const protector = resolveAtRestProtector(securityDir, { ...options, createIfMissing: false });
  try {
    return protector.unprotect(text);
  } catch {
    return null;
  }
}

/** 供测试清缓存(密钥箱轮换后重解)。 */
export function clearAtRestProtectorCache(): void {
  protectorCache.clear();
}
