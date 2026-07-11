// 个人记忆 owner 边界(host · L1 领域层 · memory)
// ---------------------------------------------------------------------------
// 职责:严格校验 tenant+user,并生成不含原始标识的稳定物理命名空间。个人记忆的
//       file/sqlite/postgres/knowledge/conversation 路径与 key 必须统一经过本模块。
import crypto from 'node:crypto';
import path from 'node:path';
import { types as utilTypes } from 'node:util';
import {
  LOCAL_IDENTITY_SCOPE,
  requireIdentityScopeFrom,
  type IdentityScope,
} from '../security/identity-scope.js';
import { NOTE_NAME_RE } from './memory-constants.js';
import { memoryDir } from './memory-utils.js';

const OWNER_KEY_VERSION = 'v1';

export type MemoryOwnerContext = { tenantId?: unknown; userId?: unknown };
export type MemoryOwner = IdentityScope;

export class MemoryOwnerError extends Error {
  readonly statusCode = 400;
}

function isMissingOwnerPart(context: unknown, key: 'tenantId' | 'userId'): boolean {
  if (context === null || typeof context !== 'object') return true;
  if (utilTypes.isProxy(context)) return false;
  if (Array.isArray(context)) return true;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(context, key);
    return !descriptor || (Object.hasOwn(descriptor, 'value') && descriptor.value === undefined);
  } catch {
    return false;
  }
}

/** 缺 tenant 或 user 一律抛错；不使用 local 默认值，也不截断产生 owner 碰撞。 */
export function requireMemoryOwner(context?: MemoryOwnerContext): MemoryOwner {
  try {
    return requireIdentityScopeFrom(context, { label: 'memory owner' });
  } catch (error) {
    if (isMissingOwnerPart(context, 'tenantId')) {
      throw new MemoryOwnerError('memory owner tenantId is required');
    }
    if (isMissingOwnerPart(context, 'userId')) {
      throw new MemoryOwnerError('memory owner userId is required');
    }
    const detail = error instanceof Error ? error.message : 'memory owner is invalid';
    throw new MemoryOwnerError(detail);
  }
}

/** 固定版本 + 完整 SHA-256(owner tuple)，不会把原始 tenant/user 放进路径或 note key。 */
export function memoryOwnerStorageKey(context: MemoryOwnerContext): string {
  const owner = requireMemoryOwner(context);
  const digest = crypto
    .createHash('sha256')
    .update(JSON.stringify([owner.tenantId, owner.userId]))
    .digest('hex');
  return `${OWNER_KEY_VERSION}-${digest}`;
}

export function isLegacyLocalMemoryOwner(context: MemoryOwnerContext): boolean {
  const owner = requireMemoryOwner(context);
  return owner.tenantId === LOCAL_IDENTITY_SCOPE.tenantId
    && owner.userId === LOCAL_IDENTITY_SCOPE.userId;
}

export function memoryOwnerDir(trustedRoot: unknown, context: MemoryOwnerContext): string {
  return path.join(memoryDir(trustedRoot), 'owners', memoryOwnerStorageKey(context));
}

export function memoryOwnerMainPath(trustedRoot: unknown, context: MemoryOwnerContext): string {
  return path.join(memoryOwnerDir(trustedRoot, context), 'MEMORY.md');
}

export function memoryOwnerNotesDir(trustedRoot: unknown, context: MemoryOwnerContext): string {
  return path.join(memoryOwnerDir(trustedRoot, context), 'notes');
}

/** DB 兼容键：保留逻辑名用于可逆展示，owner hash 规避现有 UNIQUE(tenant_id,name) 冲突。 */
export function memoryStorageNoteName(noteName: string, context: MemoryOwnerContext): string {
  if (!NOTE_NAME_RE.test(String(noteName || ''))) throw new Error('Invalid memory note name');
  return `${memoryOwnerStorageKey(context)}--${noteName}`;
}

/** 只解码当前 owner 的物理键；legacy 逻辑键仅显式 local/local owner 可见。 */
export function memoryLogicalNoteName(storageName: unknown, context: MemoryOwnerContext): string | null {
  const name = String(storageName || '');
  const prefix = `${memoryOwnerStorageKey(context)}--`;
  if (name.startsWith(prefix)) {
    const logical = name.slice(prefix.length);
    return NOTE_NAME_RE.test(logical) ? logical : null;
  }
  return isLegacyLocalMemoryOwner(context) && NOTE_NAME_RE.test(name) ? name : null;
}
