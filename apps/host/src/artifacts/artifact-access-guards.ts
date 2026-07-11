// Artifact 通用访问适配(host · L1 领域层 · artifacts)
// ---------------------------------------------------------------------------
// 职责:为路由/工具提供 owner-aware 的单文件读取、批量过滤和静态写预留。
import path from 'node:path';

import {
  assertExternalWorkspacePath,
  assertExternalWorkspaceRoot,
  externalWorkspaceEntryAllowed,
} from '../security/external-workspace-boundary.js';
import { assertTrustedPath } from '../security/path-policy.js';
import { normalizeArtifactOwner } from './artifact-owner.js';
import {
  artifactOwnerReadAllowed,
  inspectArtifactOwnerRead,
  isArtifactOwnerMetadataPath,
  prepareArtifactOwnerWrite,
} from './artifact-owner-write.js';
import type { ArtifactOwnerWritePreparation } from './artifact-owner-write.js';

export type ArtifactAccessGuards = Readonly<{
  owner: unknown;
  readPath(input: unknown): string;
  prepareWrite(
    input: unknown,
    nextContent?: string | Buffer,
  ): { path: string; preparation: ArtifactOwnerWritePreparation | null };
  includeEntry(fullPath: string, kind: 'file' | 'directory'): boolean;
  inspectFiles(files: unknown): void;
}>;

export function createArtifactAccessGuards(trustedRoot: string, context: unknown): ArtifactAccessGuards {
  const safeRoot = assertExternalWorkspaceRoot(trustedRoot);
  let owner: unknown = Object.freeze({});
  let ownerError: unknown = null;
  try {
    owner = Object.freeze({ ...normalizeArtifactOwner(context, { allowLocalDefault: true }) });
  } catch (error) {
    ownerError = error;
  }
  const requireOwner = (): unknown => {
    if (ownerError) throw ownerError;
    return owner;
  };
  const readPath = (input: unknown): string => {
    const candidate = String(input || '');
    assertTrustedPath(candidate, safeRoot);
    const artifactPath = assertExternalWorkspacePath(candidate, safeRoot);
    inspectArtifactOwnerRead({ trustedRoot: safeRoot, artifactPath, owner: requireOwner() });
    return artifactPath;
  };
  return Object.freeze({
    owner,
    readPath,
    prepareWrite(input: unknown, nextContent?: string | Buffer) {
      const artifactPath = assertExternalWorkspacePath(String(input || ''), safeRoot);
      return {
        path: artifactPath,
        preparation: prepareArtifactOwnerWrite({
          trustedRoot: safeRoot,
          artifactPath,
          owner: requireOwner(),
          ...(nextContent === undefined ? {} : { nextContent }),
        }),
      };
    },
    includeEntry(fullPath: string, kind: 'file' | 'directory') {
      const scopedOwner = requireOwner();
      const artifactPath = path.isAbsolute(fullPath) ? fullPath : path.resolve(safeRoot, fullPath);
      if (!externalWorkspaceEntryAllowed(artifactPath, safeRoot, kind)) return false;
      if (isArtifactOwnerMetadataPath({ trustedRoot: safeRoot, artifactPath })) return false;
      if (kind === 'directory') return true;
      return artifactOwnerReadAllowed({
        trustedRoot: safeRoot,
        artifactPath,
        owner: scopedOwner,
      });
    },
    inspectFiles(files: unknown) {
      if (!Array.isArray(files)) return;
      for (const file of files) readPath(file);
    },
  });
}
