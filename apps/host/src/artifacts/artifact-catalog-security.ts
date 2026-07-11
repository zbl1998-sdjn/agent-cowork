// Artifact catalog 授权与 rename 事务(host · L1 领域层 · artifacts)
// ---------------------------------------------------------------------------
// 职责:校验 catalog 文件及 live HTML/manifest 配对 owner，并以「先建目标 claim、后移动、
//       最后删旧 claim」顺序执行可回滚 rename。
import fs from 'node:fs';
import path from 'node:path';

import {
  createArtifactCatalogRenameFilesystem,
} from './artifact-catalog-rename-filesystem.js';
import {
  artifactOwnerMetadata,
  authorizeArtifactOwner,
  artifactOwnerClaimPath,
  ensureArtifactOwnerClaim,
  removeAuthorizedArtifactOwnerClaim,
  removeCreatedArtifactOwnerClaim,
} from './artifact-owner.js';
import type {
  ArtifactOwnerAuthorization,
  ArtifactOwnerClaimResult,
} from './artifact-owner.js';
import type {
  ArtifactCatalogRenameFilesystem,
} from './artifact-catalog-rename-filesystem.js';
import {
  isAuthorizedLiveArtifactPair,
  isLiveManifestForPath,
  readArtifactTextFile,
  validateJsonArtifactOwner,
} from './artifact-catalog-manifest.js';
import { hasLiveArtifactHtmlSentinel } from './live-artifact-contract.js';

type StatusError = Error & { statusCode: number };

function statusError(message: string, statusCode: number): StatusError {
  const error = new Error(message) as StatusError;
  error.statusCode = statusCode;
  return error;
}

export function authorizeCatalogArtifactFile(
  trustedRoot: string,
  filePath: string,
  context: unknown,
): ArtifactOwnerAuthorization {
  const authorization = authorizeArtifactOwner({ trustedRoot, artifactPath: filePath, context });
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.json' && !authorization.legacy) {
    validateJsonArtifactOwner({ trustedRoot, filePath, authorization });
  }
  if (!['.html', '.htm'].includes(extension)) return authorization;
  const html = readArtifactTextFile(trustedRoot, filePath);
  if (!hasLiveArtifactHtmlSentinel(html)) return authorization;
  if (!isAuthorizedLiveArtifactPair({
    trustedRoot,
    filePath,
    context,
    authorization,
  })) throw statusError('artifact not found', 404);
  return authorization;
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code;
}

function rollbackFailure(primary: unknown, rollback: unknown): AggregateError {
  return new AggregateError(
    [primary, rollback],
    `artifact rename failed: ${String(primary)}; rollback failed: ${String(rollback)}`,
    { cause: primary },
  );
}

function rollbackOwnedRename({
  primary,
  filesystem,
  targetClaim,
  originalSourceContent,
}: {
  primary: unknown;
  filesystem: ArtifactCatalogRenameFilesystem;
  targetClaim: ArtifactOwnerClaimResult;
  originalSourceContent: string | null;
}): never {
  const failures: unknown[] = [];
  try {
    filesystem.rollbackMove(originalSourceContent);
  } catch (error) {
    failures.push(error);
  }
  try {
    if (!filesystem.targetStillPublished()) {
      removeCreatedArtifactOwnerClaim(targetClaim, {
        beforeFilesystemMutation: filesystem.guardMutation,
      });
    }
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0) {
    throw new AggregateError(
      [primary, ...failures],
      `artifact rename failed: ${String(primary)}; rollback failed: ${failures.map(String).join('; ')}`,
      { cause: primary },
    );
  }
  throw primary;
}

export function renameCatalogArtifactWithOwner({
  trustedRoot,
  source,
  target,
  context,
  authorization,
}: {
  trustedRoot: string;
  source: string;
  target: string;
  context: unknown;
  authorization: ArtifactOwnerAuthorization;
}): void {
  const filesystem = createArtifactCatalogRenameFilesystem({ trustedRoot, source, target });
  if (isAuthorizedLiveArtifactPair({ trustedRoot, filePath: source, context, authorization })) {
    throw statusError('live artifact pair cannot be renamed individually', 409);
  }
  filesystem.verifySource();
  if (filesystem.targetExists()) {
    authorizeArtifactOwner({
      trustedRoot,
      artifactPath: target,
      context,
      beforeFilesystemMutation: filesystem.guardMutation,
    });
    throw statusError('artifact target already exists', 409);
  }
  if (authorization.legacy) {
    const targetAuthorization = authorizeArtifactOwner({
      trustedRoot,
      artifactPath: target,
      context,
      beforeFilesystemMutation: filesystem.guardMutation,
    });
    if (!targetAuthorization.legacy) throw statusError('artifact target already exists', 409);
    try {
      filesystem.publish();
      filesystem.deleteSource();
    } catch (error) {
      try {
        filesystem.rollbackMove(null);
      } catch (rollback) {
        throw rollbackFailure(error, rollback);
      }
      throw error;
    }
    filesystem.verifyTarget();
    return;
  }

  const targetClaim = ensureArtifactOwnerClaim({
    trustedRoot,
    artifactPath: target,
    owner: context,
    beforeFilesystemMutation: filesystem.guardMutation,
  });
  if (!targetClaim.created) throw statusError('artifact target already exists', 409);

  let originalJson: string | null = null;
  let renamedJson: string | null = null;
  if (path.extname(source).toLowerCase() === '.json') {
    filesystem.verifySource();
    const record = validateJsonArtifactOwner({ trustedRoot, filePath: source, authorization });
    filesystem.verifySource();
    if (isLiveManifestForPath(record, source)) {
      originalJson = fs.readFileSync(source, 'utf8');
      filesystem.verifySource();
      const sourceId = path.basename(source, path.extname(source));
      const targetId = path.basename(target, path.extname(target));
      renamedJson = `${JSON.stringify({
        ...record,
        id: targetId,
        dataUrl: record.dataUrl === `/api/artifacts/data/${sourceId}`
          ? `/api/artifacts/data/${targetId}`
          : record.dataUrl,
        owner: artifactOwnerMetadata({ trustedRoot, artifactPath: target, owner: context }),
      }, null, 2)}\n`;
    }
  }

  try {
    filesystem.publish();
    if (renamedJson !== null) filesystem.replaceTarget(renamedJson);
    filesystem.deleteSource();
    filesystem.verifyTarget();
  } catch (error) {
    rollbackOwnedRename({
      primary: error,
      filesystem,
      targetClaim,
      originalSourceContent: originalJson,
    });
  }

  try {
    removeAuthorizedArtifactOwnerClaim({
      trustedRoot,
      artifactPath: source,
      authorization,
      beforeFilesystemMutation: filesystem.guardMutation,
    });
  } catch (error) {
    const sourceClaimPath = artifactOwnerClaimPath({ trustedRoot, artifactPath: source });
    let oldClaimStillPresent = true;
    try {
      filesystem.guardMutation(sourceClaimPath);
      fs.lstatSync(sourceClaimPath);
    } catch (claimStatusError) {
      if (isCode(claimStatusError, 'ENOENT')) oldClaimStillPresent = false;
      else throw rollbackFailure(error, claimStatusError);
    }
    if (!oldClaimStillPresent) return;
    try {
      authorizeArtifactOwner({
        trustedRoot,
        artifactPath: source,
        context,
        beforeFilesystemMutation: filesystem.guardMutation,
      });
    } catch (claimVerificationError) {
      throw rollbackFailure(error, claimVerificationError);
    }
    rollbackOwnedRename({
      primary: error,
      filesystem,
      targetClaim,
      originalSourceContent: originalJson,
    });
  }
  filesystem.verifyTarget();
}
