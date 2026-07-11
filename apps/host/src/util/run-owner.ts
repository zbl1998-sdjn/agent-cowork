// Run 资源 owner 规范化(host · L0 基础层 · util)
// ---------------------------------------------------------------------------
// 职责:把 tenantId/userId 组成不可含糊的 owner,供 checkpoint 与 run record 在共享存储中
//      执行同主体校验。缺字段默认拒绝;仅显式 legacy/local 调用可回退本地主体。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  LOCAL_IDENTITY_SCOPE,
  requireIdentityScopeFrom,
  type IdentityScope,
} from '../security/identity-scope.js';
import {
  createManagedDirectoryBoundary,
  type ManagedDirectoryBoundary,
} from '../security/managed-directory-boundary.js';
import { readPrivateManagedFile } from '../security/managed-private-file.js';
import { assertTrustedPathForCreate } from '../security/path-policy.js';
import { writePrivateFileOnceAtomically } from '../security/private-atomic-file.js';

export type RunOwner = IdentityScope;

export const LOCAL_RUN_OWNER: RunOwner = LOCAL_IDENTITY_SCOPE;

type NormalizeRunOwnerOptions = {
  allowLocalDefault?: boolean;
  label?: string;
};

type EnsureRunOwnerClaimOptions = {
  claimPath: string;
  owner: RunOwner;
  label?: string;
  beforeFilesystemMutation?: (candidatePath: string) => void;
  boundary?: ManagedDirectoryBoundary;
};

export function normalizeRunOwner(
  value: unknown,
  { allowLocalDefault = false, label = 'Run owner' }: NormalizeRunOwnerOptions = {},
): RunOwner {
  return requireIdentityScopeFrom(value, { allowLocalDefault, label });
}

export function sameRunOwner(left: RunOwner, right: RunOwner): boolean {
  return left.tenantId === right.tenantId && left.userId === right.userId;
}

export function isLocalRunOwner(owner: RunOwner): boolean {
  return sameRunOwner(owner, LOCAL_RUN_OWNER);
}

export function runOwnerClaimPath(root: string, resourceId: unknown): string {
  const id = typeof resourceId === 'string' ? resourceId : '';
  if (!id) throw new Error('Run owner claim: resource id is required');
  const claimName = crypto.createHash('sha256').update(id).digest('hex');
  return path.join(root, '.owners', `${claimName}.json`);
}

function ownerDigest(owner: RunOwner): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify([owner.tenantId, owner.userId]))
    .digest('hex');
}

type ClaimInspection = Readonly<{
  safePath: string;
  stats: fs.Stats;
}>;

function samePath(left: string, right: string): boolean {
  return path.relative(path.resolve(left), path.resolve(right)) === '';
}

function sameClaimIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs;
}

function inspectClaim(
  claimPath: string,
  trustedRoot: string,
  label: string,
): ClaimInspection {
  const safePath = assertTrustedPathForCreate(claimPath, trustedRoot);
  const stats = fs.lstatSync(claimPath);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`${label} owner claim must be a regular file`);
  }
  return { safePath, stats };
}

export function ensureRunOwnerClaim({
  claimPath,
  owner,
  label = 'Run resource',
  beforeFilesystemMutation,
  boundary,
}: EnsureRunOwnerClaimOptions): void {
  const claimRoot = path.dirname(claimPath);
  if (path.basename(claimRoot) !== '.owners') {
    throw new Error(`${label} owner claim must be stored under .owners`);
  }
  const trustedRoot = path.dirname(claimRoot);
  const claimBoundary = boundary ?? createManagedDirectoryBoundary(trustedRoot, {
    label: `${label} owner claim root`,
  });
  const guardBoundaryMutation = claimBoundary.createMutationGuard();
  const guardClaimPath = (candidatePath: string): void => {
    beforeFilesystemMutation?.(candidatePath);
    assertTrustedPathForCreate(candidatePath, trustedRoot);
    guardBoundaryMutation(candidatePath);
  };
  guardClaimPath(claimPath);
  const safeClaimPath = assertTrustedPathForCreate(claimPath, trustedRoot);
  if (fs.existsSync(claimPath)) {
    inspectClaim(claimPath, trustedRoot, label);
  }
  const claim = {
    version: 1,
    ownerSha256: ownerDigest(owner),
  };
  const created = writePrivateFileOnceAtomically(
    safeClaimPath,
    `${JSON.stringify(claim)}\n`,
    {
      beforeFilesystemMutation(candidatePath) {
        guardClaimPath(candidatePath);
        if (fs.existsSync(candidatePath) && fs.lstatSync(candidatePath).isSymbolicLink()) {
          throw new Error(`${label} owner claim path must not contain a symbolic link or reparse point`);
        }
      },
    },
  );
  if (created) {
    inspectClaim(claimPath, trustedRoot, label);
    return;
  }

  let stored: unknown;
  try {
    const before = inspectClaim(claimPath, trustedRoot, label);
    const raw = readPrivateManagedFile(claimBoundary, claimPath, guardClaimPath);
    if (raw === null) throw new Error('owner claim disappeared during verification');
    stored = JSON.parse(raw) as unknown;
    const after = inspectClaim(claimPath, trustedRoot, label);
    if (
      !samePath(before.safePath, after.safePath)
      || !sameClaimIdentity(before.stats, after.stats)
    ) {
      throw new Error('owner claim changed during verification');
    }
  } catch {
    throw new Error(`${label} owner claim could not be verified`);
  }
  const storedRecord = stored as Record<string, unknown> | null;
  if (
    !storedRecord
    || typeof storedRecord !== 'object'
    || Array.isArray(storedRecord)
    || storedRecord.version !== 1
    || typeof storedRecord.ownerSha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(storedRecord.ownerSha256)
  ) {
    throw new Error(`${label} owner claim could not be verified`);
  }
  if (storedRecord.ownerSha256 !== claim.ownerSha256) {
    throw new Error(`${label} owner mismatch`);
  }
}
