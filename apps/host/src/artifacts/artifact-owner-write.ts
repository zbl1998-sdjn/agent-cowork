// Artifact 写操作所有权适配(host · L1 领域层 · artifacts)
// ---------------------------------------------------------------------------
// 职责:识别 artifact 路径，为静态写入预检/预留 owner claim，并阻断通用文件接口绕过
//       artifact rename 的原子 claim 迁移。
import fs from 'node:fs';
import path from 'node:path';

import {
  assertExternalWorkspacePath,
  assertExternalWorkspaceRoot,
} from '../security/external-workspace-boundary.js';
import { assertTrustedPath, assertTrustedPathForCreate } from '../security/path-policy.js';
import {
  artifactOwnerClaimPath,
  authorizeArtifactOwner,
  ensureArtifactOwnerClaim,
  removeAuthorizedArtifactOwnerClaim,
  removeCreatedArtifactOwnerClaim,
} from './artifact-owner.js';
import { prepareManagedArtifactOwnerRename } from './artifact-owner-rename.js';
import { assertNoLiveArtifactMutation } from './live-artifact-immutability.js';

const ARTIFACT_PARTS = ['.AgentCowork', 'artifacts'];
const CLAIM_DIR = '.owners';

type ArtifactPathOptions = { trustedRoot: string; artifactPath: string };
export type ArtifactOwnerWritePreparation = Readonly<{ abort(): void }>;
type ArtifactRollbackPreparation = Readonly<{
  beforeMutation?(): void;
  commit(): void;
  abort(): void;
}>;
const commitArtifactRollback = (): void => undefined;

function artifactRelativePath({
  trustedRoot,
  artifactPath,
}: ArtifactPathOptions): string | null {
  const root = path.resolve(trustedRoot);
  const safePath = assertTrustedPathForCreate(path.resolve(artifactPath), root);
  const artifactRoot = assertTrustedPathForCreate(path.join(root, ...ARTIFACT_PARTS), root);
  const relativePath = path.relative(artifactRoot, safePath).replace(/\\/g, '/');
  return relativePath
    && relativePath !== '..'
    && !relativePath.startsWith('../')
    && !path.isAbsolute(relativePath)
    ? relativePath
    : null;
}

export function isArtifactOwnerMetadataPath(options: ArtifactPathOptions): boolean {
  const relativePath = artifactRelativePath(options);
  return relativePath === CLAIM_DIR || Boolean(relativePath?.startsWith(`${CLAIM_DIR}/`));
}

export function isArtifactOwnerManagedPath(options: ArtifactPathOptions): boolean {
  const relativePath = artifactRelativePath(options);
  return Boolean(
    relativePath
    && relativePath !== CLAIM_DIR
    && !relativePath.startsWith(`${CLAIM_DIR}/`),
  );
}

function artifactConflict(): Error & { statusCode: number } {
  const error = new Error('artifact target already exists') as Error & { statusCode: number };
  error.statusCode = 409;
  return error;
}

export function inspectArtifactOwnerWrite(
  options: ArtifactPathOptions & { owner: unknown; nextContent?: string | Buffer },
): void {
  if (isArtifactOwnerMetadataPath(options)) throw artifactNotFound();
  if (!isArtifactOwnerManagedPath(options)) return;
  const claimExists = fs.existsSync(artifactOwnerClaimPath(options));
  if (!fs.existsSync(options.artifactPath) && !claimExists) {
    assertNoLiveArtifactMutation(options.artifactPath, options.nextContent);
    return;
  }
  authorizeArtifactOwner({ ...options, context: options.owner });
  assertNoLiveArtifactMutation(options.artifactPath, options.nextContent);
  if (!fs.existsSync(options.artifactPath)) throw artifactConflict();
}

export function inspectArtifactOwnerRead(
  options: ArtifactPathOptions & { owner: unknown },
): void {
  if (isArtifactOwnerMetadataPath(options)) throw artifactNotFound();
  if (!isArtifactOwnerManagedPath(options)) return;
  authorizeArtifactOwner({ ...options, context: options.owner });
}

export function artifactOwnerReadAllowed(
  options: ArtifactPathOptions & { owner: unknown },
): boolean {
  try {
    inspectArtifactOwnerRead(options);
    return true;
  } catch (error) {
    if ((error as { statusCode?: unknown }).statusCode === 404) return false;
    throw error;
  }
}

export function prepareArtifactOwnerWrite(
  options: ArtifactPathOptions & { owner: unknown; nextContent?: string | Buffer },
): ArtifactOwnerWritePreparation | null {
  if (isArtifactOwnerMetadataPath(options)) throw artifactNotFound();
  if (!isArtifactOwnerManagedPath(options)) return null;
  if (fs.existsSync(options.artifactPath)) {
    authorizeArtifactOwner({ ...options, context: options.owner });
    assertNoLiveArtifactMutation(options.artifactPath, options.nextContent);
    return null;
  }
  assertNoLiveArtifactMutation(options.artifactPath, options.nextContent);
  const claim = ensureArtifactOwnerClaim(options);
  if (!claim.created) throw artifactConflict();
  return Object.freeze({
    abort() {
      if (!fs.existsSync(options.artifactPath)) removeCreatedArtifactOwnerClaim(claim);
    },
  });
}

export function createArtifactFileOperationGuards(trustedRoot: string, owner: unknown) {
  const safeRoot = assertExternalWorkspaceRoot(trustedRoot);
  return {
    inspectWrite: (artifactPath: string, nextContent: Buffer) => {
      const safePath = assertExternalWorkspacePath(artifactPath, safeRoot);
      inspectArtifactOwnerWrite({
        trustedRoot: safeRoot,
        artifactPath: safePath,
        owner,
        nextContent,
      });
    },
    inspectMove: (source: string, target: string) => {
      const safeSource = assertExternalWorkspacePath(source, safeRoot);
      const safeTarget = assertExternalWorkspacePath(target, safeRoot);
      if (isArtifactOwnerMetadataPath({ trustedRoot: safeRoot, artifactPath: safeSource })
        || isArtifactOwnerMetadataPath({ trustedRoot: safeRoot, artifactPath: safeTarget })) {
        throw artifactNotFound();
      }
      const sourceIsArtifact = isArtifactOwnerManagedPath({ trustedRoot: safeRoot, artifactPath: safeSource });
      const targetIsArtifact = isArtifactOwnerManagedPath({ trustedRoot: safeRoot, artifactPath: safeTarget });
      if (sourceIsArtifact) authorizeArtifactOwner({ trustedRoot: safeRoot, artifactPath: safeSource, context: owner });
      if (sourceIsArtifact || targetIsArtifact) {
        throw new Error('artifact rename/move must use /api/artifacts/rename');
      }
    },
    prepareWrite: (artifactPath: string, nextContent?: string | Buffer) => prepareArtifactOwnerWrite({
      trustedRoot: safeRoot,
      artifactPath: assertExternalWorkspacePath(artifactPath, safeRoot),
      owner,
      ...(nextContent === undefined ? {} : { nextContent }),
    }),
  };
}

function prepareArtifactOwnerDelete(
  options: ArtifactPathOptions & { owner: unknown },
): ArtifactRollbackPreparation | null {
  if (isArtifactOwnerMetadataPath(options)) throw artifactNotFound();
  if (!isArtifactOwnerManagedPath(options)) return null;
  const authorization = authorizeArtifactOwner({ ...options, context: options.owner });
  assertNoLiveArtifactMutation(options.artifactPath);
  if (authorization.legacy) throw artifactNotFound();
  removeAuthorizedArtifactOwnerClaim({ ...options, authorization });
  return Object.freeze({
    commit: commitArtifactRollback,
    abort() {
      if (fs.existsSync(options.artifactPath)) ensureArtifactOwnerClaim(options);
    },
  });
}

function prepareArtifactOwnerRestore(
  options: ArtifactPathOptions & { owner: unknown },
  backupPath: string,
): ArtifactRollbackPreparation | null {
  const preparation = prepareArtifactOwnerWrite({
    ...options,
    nextContent: fs.readFileSync(backupPath),
  });
  return preparation
    ? Object.freeze({ commit: commitArtifactRollback, abort: () => preparation.abort() })
    : null;
}

function prepareArtifactOwnerRename(
  trustedRoot: string,
  source: string,
  target: string,
  owner: unknown,
): ArtifactRollbackPreparation | null {
  const sourceOptions = { trustedRoot, artifactPath: source };
  const targetOptions = { trustedRoot, artifactPath: target };
  if (isArtifactOwnerMetadataPath(sourceOptions) || isArtifactOwnerMetadataPath(targetOptions)) {
    throw artifactNotFound();
  }
  const sourceManaged = isArtifactOwnerManagedPath(sourceOptions);
  const targetManaged = isArtifactOwnerManagedPath(targetOptions);
  if (!sourceManaged && !targetManaged) return null;
  if (!sourceManaged || !targetManaged) throw artifactNotFound();
  authorizeArtifactOwner({ ...sourceOptions, context: owner });
  assertNoLiveArtifactMutation(source);
  return prepareManagedArtifactOwnerRename({ trustedRoot, source, target, owner });
}

export function createArtifactRollbackGuards(trustedRoot: string, owner: unknown) {
  const safeRoot = assertExternalWorkspaceRoot(trustedRoot);
  return {
    prepareDeleteCreated: (artifactPath: string) => (
      prepareArtifactOwnerDelete({
        trustedRoot: safeRoot,
        artifactPath: assertExternalWorkspacePath(artifactPath, safeRoot),
        owner,
      })
    ),
    prepareRestoreBackup: (artifactPath: string, backupPath: string) => (
      prepareArtifactOwnerRestore({
        trustedRoot: safeRoot,
        artifactPath: assertExternalWorkspacePath(artifactPath, safeRoot),
        owner,
      }, assertTrustedPath(backupPath, safeRoot))
    ),
    prepareRenameBack: (source: string, target: string) => (
      prepareArtifactOwnerRename(
        safeRoot,
        assertExternalWorkspacePath(source, safeRoot),
        assertExternalWorkspacePath(target, safeRoot),
        owner,
      )
    ),
  };
}

function artifactNotFound(): Error & { statusCode: number } {
  const error = new Error('artifact not found') as Error & { statusCode: number };
  error.statusCode = 404;
  return error;
}
