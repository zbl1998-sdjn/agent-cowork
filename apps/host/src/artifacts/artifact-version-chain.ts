// Immutable live-artifact lineage and integrity checks (host · L1 artifacts).
// Legacy schema-v1 pairs remain readable as singleton lineages; only pairs with a stored
// content hash may be used as parents for a newly published version.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { readLiveArtifactPair } from './live-artifact-reader.js';
import { artifactPaths, fail } from './live-spec.js';
import type { ArtifactManifest } from './live-artifact-reader.js';

const SHA256_RE = /^[a-f0-9]{64}$/;
const ARTIFACT_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export type ArtifactVersionSummary = Readonly<{
  id: string;
  lineageId: string;
  parentVersionId?: string;
  contentSha256: string;
  hashVerified: boolean;
  title: string;
  createdAt: string;
  viewUrl: string;
}>;

type ArtifactPair = Readonly<{ manifest: ArtifactManifest; html: string }>;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item) ?? null);
  if (value && typeof value === 'object') {
    const result = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const normalized = canonicalize((value as Record<string, unknown>)[key]);
      if (normalized !== undefined) result[key] = normalized;
    }
    return result;
  }
  return JSON.stringify(value) === undefined ? undefined : value;
}

export function computeArtifactContentSha256(manifest: ArtifactManifest, html: string): string {
  const manifestRecord = { ...(manifest as unknown as Record<string, unknown>) };
  delete manifestRecord.contentSha256;
  const canonicalManifest = JSON.stringify(canonicalize(manifestRecord));
  return crypto
    .createHash('sha256')
    .update('agent-cowork-live-artifact-content:v1\n')
    .update(canonicalManifest)
    .update('\n')
    .update(html)
    .digest('hex');
}

export function verifyArtifactContentHash(
  pair: ArtifactPair,
  { requireStoredHash = false }: { requireStoredHash?: boolean } = {},
): { contentSha256: string; hashVerified: boolean } {
  const computed = computeArtifactContentSha256(pair.manifest, pair.html);
  const stored = pair.manifest.contentSha256;
  if (stored === undefined) {
    if (requireStoredHash) throw fail('parent version has no verifiable content hash', 409);
    return { contentSha256: computed, hashVerified: false };
  }
  if (!SHA256_RE.test(stored) || stored !== computed) {
    throw fail('artifact version content hash mismatch', 409);
  }
  return { contentSha256: computed, hashVerified: true };
}

function versionSummary(pair: ArtifactPair): ArtifactVersionSummary {
  const integrity = verifyArtifactContentHash(pair);
  const lineageId = pair.manifest.lineageId || pair.manifest.id;
  return Object.freeze({
    id: pair.manifest.id,
    lineageId,
    ...(pair.manifest.parentVersionId ? { parentVersionId: pair.manifest.parentVersionId } : {}),
    ...integrity,
    title: pair.manifest.title,
    createdAt: pair.manifest.createdAt,
    viewUrl: `/api/artifacts/live/${encodeURIComponent(pair.manifest.id)}`,
  });
}

function isNotFound(error: unknown): boolean {
  return (error as { statusCode?: unknown }).statusCode === 404;
}

export function listArtifactVersions({
  trustedRoot,
  id,
  context,
}: {
  trustedRoot: string;
  id: string;
  context?: unknown;
}): ArtifactVersionSummary[] {
  const seed = readLiveArtifactPair({ trustedRoot, id, context });
  const lineageId = seed.manifest.lineageId || seed.manifest.id;
  const { dir } = artifactPaths({ trustedRoot, id });
  const versions: ArtifactVersionSummary[] = [];

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.json') continue;
    const candidateId = path.basename(entry.name, path.extname(entry.name));
    if (!ARTIFACT_ID_RE.test(candidateId)) continue;
    let pair: ArtifactPair;
    try {
      pair = readLiveArtifactPair({ trustedRoot, id: candidateId, context });
    } catch (error) {
      // Owner/pair checks happen inside readLiveArtifactPair before bytes are read.
      // Hide inaccessible and malformed sibling artifacts so they cannot deny this lineage.
      if (isNotFound(error)) continue;
      throw error;
    }
    if ((pair.manifest.lineageId || pair.manifest.id) !== lineageId) continue;
    versions.push(versionSummary(pair));
  }

  return versions.sort((left, right) => {
    const byCreatedAt = right.createdAt.localeCompare(left.createdAt);
    return byCreatedAt || right.id.localeCompare(left.id);
  });
}
