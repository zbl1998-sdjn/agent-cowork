// Artifact 所有权 claim(host · L1 领域层 · artifacts)
// ---------------------------------------------------------------------------
// 职责:把 artifact 文件路径绑定到 tenant/user owner 的不可逆摘要；读取时精确校验主体，
//       legacy 无 claim 仅允许本地主体。claim 不落原始 tenantId/userId，避免元数据泄露。
import crypto from 'node:crypto';
import path from 'node:path';

import { LOCAL_IDENTITY_SCOPE, requireIdentityScopeFrom } from '../security/identity-scope.js';
import { ManagedStateFilesystem } from '../security/managed-state-filesystem.js';
import { assertTrustedPathForCreate } from '../security/path-policy.js';
import { writePrivateFileOnceAtomically } from '../security/private-atomic-file.js';
import type { IdentityScope } from '../security/identity-scope.js';

const ARTIFACT_PARTS = ['.AgentCowork', 'artifacts'];
const CLAIM_DIR = '.owners';
const SHA256_RE = /^[a-f0-9]{64}$/;

export type ArtifactOwner = IdentityScope;
export type ArtifactOwnerMetadata = Readonly<{
  version: 1;
  relativePathSha256: string;
  ownerSha256: string;
}>;
export type ArtifactOwnerAuthorization = Readonly<{
  legacy: boolean;
  metadata: ArtifactOwnerMetadata | null;
}>;
export type ArtifactOwnerClaimResult = Readonly<{
  claimPath: string;
  created: boolean;
  metadata: ArtifactOwnerMetadata;
}>;

export const LOCAL_ARTIFACT_OWNER: ArtifactOwner = LOCAL_IDENTITY_SCOPE;

type ArtifactPathOptions = {
  trustedRoot: string; artifactPath: string;
  beforeFilesystemMutation?: (candidatePath: string) => void;
};
type ClaimOperation = Readonly<{ filesystem: ManagedStateFilesystem; claimPath: string }>;
const createdClaimStates = new WeakMap<ArtifactOwnerClaimResult, ClaimOperation>();
const authorizationStates = new WeakMap<ArtifactOwnerAuthorization, ClaimOperation>();
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function artifactNotFound(): Error & { statusCode: number } {
  const error = new Error('artifact not found') as Error & { statusCode: number };
  error.statusCode = 404;
  return error;
}

export function normalizeArtifactOwner(value: unknown, { allowLocalDefault = false }: { allowLocalDefault?: boolean } = {}): ArtifactOwner {
  try {
    return requireIdentityScopeFrom(value, { allowLocalDefault, label: 'artifact owner' });
  } catch {
    throw artifactNotFound();
  }
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function ownerSha256(owner: ArtifactOwner): string {
  return sha256(JSON.stringify([owner.tenantId, owner.userId]));
}
function artifactLocation(
  { trustedRoot, artifactPath }: ArtifactPathOptions,
): { workspaceRoot: string; artifactRoot: string; relativePath: string } {
  const workspaceRoot = path.resolve(trustedRoot);
  const artifactRoot = assertTrustedPathForCreate(
    path.join(workspaceRoot, ...ARTIFACT_PARTS),
    workspaceRoot,
  );
  const safePath = assertTrustedPathForCreate(path.resolve(artifactPath), workspaceRoot);
  const relativePath = path.relative(artifactRoot, safePath).replace(/\\/g, '/');
  if (!relativePath || relativePath === '..' || relativePath.startsWith('../') || path.isAbsolute(relativePath)) {
    throw artifactNotFound();
  }
  if (relativePath === CLAIM_DIR || relativePath.startsWith(`${CLAIM_DIR}/`)) {
    throw artifactNotFound();
  }
  return { workspaceRoot, artifactRoot, relativePath };
}

export function artifactOwnerMetadata({
  trustedRoot,
  artifactPath,
  owner,
}: ArtifactPathOptions & { owner: unknown }): ArtifactOwnerMetadata {
  const { relativePath } = artifactLocation({ trustedRoot, artifactPath });
  const normalizedOwner = normalizeArtifactOwner(owner);
  return Object.freeze({
    version: 1,
    relativePathSha256: sha256(relativePath),
    ownerSha256: ownerSha256(normalizedOwner),
  });
}

export function artifactOwnerClaimPath(options: ArtifactPathOptions): string {
  const { workspaceRoot, artifactRoot, relativePath } = artifactLocation(options);
  return assertTrustedPathForCreate(
    path.join(artifactRoot, CLAIM_DIR, `${sha256(relativePath)}.json`),
    workspaceRoot,
  );
}

function claimOperation(options: ArtifactPathOptions, create: boolean): ClaimOperation {
  const { workspaceRoot, artifactRoot, relativePath } = artifactLocation(options);
  const claimPath = assertTrustedPathForCreate(
    path.join(artifactRoot, CLAIM_DIR, `${sha256(relativePath)}.json`),
    workspaceRoot,
  );
  const filesystem = new ManagedStateFilesystem(artifactRoot, {
    create,
    label: 'Artifact owner directory',
    ...(options.beforeFilesystemMutation ? { beforeFilesystemMutation: options.beforeFilesystemMutation } : {}),
  });
  return { filesystem, claimPath };
}

function parseMetadata(value: unknown): ArtifactOwnerMetadata | null {
  if (!isRecord(value)
    || value.version !== 1
    || typeof value.relativePathSha256 !== 'string'
    || !SHA256_RE.test(value.relativePathSha256)
    || typeof value.ownerSha256 !== 'string'
    || !SHA256_RE.test(value.ownerSha256)) {
    return null;
  }
  return Object.freeze({
    version: 1,
    relativePathSha256: value.relativePathSha256,
    ownerSha256: value.ownerSha256,
  });
}

function readClaim(operation: ClaimOperation): ArtifactOwnerMetadata | null | undefined {
  const contents = operation.filesystem.readFile(operation.claimPath);
  if (contents === null) return undefined;
  try {
    return parseMetadata(JSON.parse(contents));
  } catch {
    return null;
  }
}

function sameMetadata(left: ArtifactOwnerMetadata, right: ArtifactOwnerMetadata): boolean {
  return left.version === right.version
    && left.relativePathSha256 === right.relativePathSha256
    && left.ownerSha256 === right.ownerSha256;
}

export function ensureArtifactOwnerClaim(
  options: ArtifactPathOptions & { owner: unknown },
): ArtifactOwnerClaimResult {
  const metadata = artifactOwnerMetadata(options);
  const operation = claimOperation(options, true);
  const created = writePrivateFileOnceAtomically(
    operation.claimPath,
    `${JSON.stringify(metadata)}\n`,
    { beforeFilesystemMutation: operation.filesystem.guardMutation },
  );
  let stored;
  try {
    stored = readClaim(operation);
  } catch {
    throw artifactNotFound();
  }
  if (!stored || !sameMetadata(stored, metadata)) throw artifactNotFound();
  const result = Object.freeze({ claimPath: operation.claimPath, created, metadata });
  if (created) createdClaimStates.set(result, operation);
  return result;
}

export function removeCreatedArtifactOwnerClaim(
  claim: ArtifactOwnerClaimResult,
  options: Pick<ArtifactPathOptions, 'beforeFilesystemMutation'> = {},
): void {
  if (!claim.created) return;
  const operation = createdClaimStates.get(claim);
  if (!operation) return;
  let stored;
  try { stored = readClaim(operation); } catch (error) {
    if (/managed path changed during operation/i.test(String(error))) return;
    throw error;
  }
  if (!stored || !sameMetadata(stored, claim.metadata)) return;
  operation.filesystem.removeFile(operation.claimPath, options.beforeFilesystemMutation);
}

export function removeAuthorizedArtifactOwnerClaim(
  options: ArtifactPathOptions & { authorization: ArtifactOwnerAuthorization },
): void {
  if (options.authorization.legacy) return;
  const expected = options.authorization.metadata;
  const operation = authorizationStates.get(options.authorization)
    ?? claimOperation(options, false);
  const stored = readClaim(operation);
  if (!stored || !expected || !sameMetadata(stored, expected)) throw artifactNotFound();
  operation.filesystem.removeFile(operation.claimPath, options.beforeFilesystemMutation);
}

export function authorizeArtifactOwner(
  options: ArtifactPathOptions & { context?: unknown },
): ArtifactOwnerAuthorization {
  const owner = normalizeArtifactOwner(options.context, { allowLocalDefault: true });
  const expected = artifactOwnerMetadata({ ...options, owner });
  let operation: ClaimOperation;
  let stored: ReturnType<typeof readClaim>;
  try {
    operation = claimOperation(options, false);
    stored = readClaim(operation);
  } catch {
    throw artifactNotFound();
  }
  if (stored === undefined) {
    if (owner.tenantId === LOCAL_ARTIFACT_OWNER.tenantId && owner.userId === LOCAL_ARTIFACT_OWNER.userId) {
      return Object.freeze({ legacy: true, metadata: null });
    }
    throw artifactNotFound();
  }
  if (!stored || !sameMetadata(stored, expected)) throw artifactNotFound();
  const authorization = Object.freeze({ legacy: false, metadata: stored });
  authorizationStates.set(authorization, operation);
  return authorization;
}

export function assertEmbeddedArtifactOwner(
  value: unknown,
  options: ArtifactPathOptions & { authorization: ArtifactOwnerAuthorization },
): void {
  if (options.authorization.legacy) {
    if (value === undefined) return;
    throw artifactNotFound();
  }
  const embedded = parseMetadata(value);
  const expected = options.authorization.metadata;
  if (!embedded || !expected || !sameMetadata(embedded, expected)) throw artifactNotFound();
}

export function sameArtifactOwnerAuthorization(
  left: ArtifactOwnerAuthorization,
  right: ArtifactOwnerAuthorization,
): boolean {
  if (left.legacy || right.legacy) return left.legacy && right.legacy;
  return Boolean(left.metadata && right.metadata && left.metadata.ownerSha256 === right.metadata.ownerSha256);
}
