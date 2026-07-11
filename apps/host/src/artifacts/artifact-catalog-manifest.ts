// Catalog live-manifest classification and pair ownership checks (host · L1 artifacts).
import fs from 'node:fs';
import path from 'node:path';

import { assertTrustedPath } from '../security/path-policy.js';
import {
  assertEmbeddedArtifactOwner,
  authorizeArtifactOwner,
  sameArtifactOwnerAuthorization,
} from './artifact-owner.js';
import {
  hasLiveArtifactHtmlSentinel,
  LIVE_ARTIFACT_SCHEMA_VERSION,
  LIVE_ARTIFACT_TYPE,
} from './live-artifact-contract.js';
import type { ArtifactOwnerAuthorization } from './artifact-owner.js';

const ARTIFACT_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;

function artifactNotFound(): Error & { statusCode: number } {
  const error = new Error('artifact not found') as Error & { statusCode: number };
  error.statusCode = 404;
  return error;
}

export function readArtifactTextFile(trustedRoot: string, filePath: string): string {
  try {
    const safePath = assertTrustedPath(filePath, trustedRoot);
    const stat = fs.lstatSync(safePath);
    if (stat.isSymbolicLink() || !stat.isFile()) throw artifactNotFound();
    const revalidatedPath = assertTrustedPath(safePath, trustedRoot);
    return fs.readFileSync(revalidatedPath, 'utf8');
  } catch (error) {
    if ((error as { statusCode?: unknown }).statusCode === 404) throw error;
    throw artifactNotFound();
  }
}

export function readArtifactJsonRecord(
  trustedRoot: string,
  filePath: string,
): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readArtifactTextFile(trustedRoot, filePath)) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw artifactNotFound();
    return parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as { statusCode?: unknown }).statusCode === 404) throw error;
    throw artifactNotFound();
  }
}

export function isLiveManifestForPath(record: Record<string, unknown>, filePath: string): boolean {
  if (record.artifactType !== LIVE_ARTIFACT_TYPE) return false;
  const expectedId = path.basename(filePath, path.extname(filePath));
  if (record.schemaVersion !== LIVE_ARTIFACT_SCHEMA_VERSION
    || record.id !== expectedId
    || typeof record.title !== 'string'
    || typeof record.dataUrl !== 'string'
    || typeof record.createdAt !== 'string'
    || !record.viz
    || typeof record.viz !== 'object'
    || Array.isArray(record.viz)) {
    throw artifactNotFound();
  }
  const hasVersionFields = record.lineageId !== undefined
    || record.parentVersionId !== undefined
    || record.contentSha256 !== undefined;
  if (hasVersionFields && (
    typeof record.lineageId !== 'string'
    || !ARTIFACT_ID_RE.test(record.lineageId)
    || (record.parentVersionId !== undefined
      && (typeof record.parentVersionId !== 'string' || !ARTIFACT_ID_RE.test(record.parentVersionId)))
    || typeof record.contentSha256 !== 'string'
    || !SHA256_RE.test(record.contentSha256)
  )) {
    throw artifactNotFound();
  }
  return true;
}

export function validateJsonArtifactOwner({
  trustedRoot,
  filePath,
  authorization,
}: {
  trustedRoot: string;
  filePath: string;
  authorization: ArtifactOwnerAuthorization;
}): Record<string, unknown> {
  const record = readArtifactJsonRecord(trustedRoot, filePath);
  if (isLiveManifestForPath(record, filePath)) {
    assertEmbeddedArtifactOwner(record.owner, {
      trustedRoot,
      artifactPath: filePath,
      authorization,
    });
  }
  return record;
}

function authorizePairFile(
  trustedRoot: string,
  artifactPath: string,
  context: unknown,
): ArtifactOwnerAuthorization | null {
  try {
    return authorizeArtifactOwner({ trustedRoot, artifactPath, context });
  } catch (error) {
    if ((error as { statusCode?: unknown }).statusCode === 404) return null;
    throw error;
  }
}

export function isAuthorizedLiveArtifactPair({
  trustedRoot,
  filePath,
  context,
  authorization,
}: {
  trustedRoot: string;
  filePath: string;
  context: unknown;
  authorization: ArtifactOwnerAuthorization;
}): boolean {
  const extension = path.extname(filePath).toLowerCase();
  const isManifest = extension === '.json';
  if (!isManifest && !['.html', '.htm'].includes(extension)) return false;
  const manifestPath = isManifest ? filePath : filePath.slice(0, -extension.length) + '.json';
  if (isManifest) {
    const manifest = validateJsonArtifactOwner({
      trustedRoot,
      filePath: manifestPath,
      authorization,
    });
    if (!isLiveManifestForPath(manifest, manifestPath)) return false;
    for (const htmlExtension of ['.html', '.htm']) {
      const htmlPath = filePath.slice(0, -extension.length) + htmlExtension;
      const htmlAuthorization = authorizePairFile(trustedRoot, htmlPath, context);
      if (!htmlAuthorization
        || !sameArtifactOwnerAuthorization(htmlAuthorization, authorization)) {
        continue;
      }
      try {
        if (hasLiveArtifactHtmlSentinel(readArtifactTextFile(trustedRoot, htmlPath))) return true;
      } catch (error) {
        if ((error as { statusCode?: unknown }).statusCode !== 404) throw error;
      }
    }
    return false;
  }

  const html = readArtifactTextFile(trustedRoot, filePath);
  if (!hasLiveArtifactHtmlSentinel(html)) return false;
  const manifestAuthorization = authorizePairFile(trustedRoot, manifestPath, context);
  if (!manifestAuthorization
    || !sameArtifactOwnerAuthorization(authorization, manifestAuthorization)) {
    return false;
  }
  const manifest = validateJsonArtifactOwner({
    trustedRoot,
    filePath: manifestPath,
    authorization: manifestAuthorization,
  });
  return isLiveManifestForPath(manifest, manifestPath);
}
