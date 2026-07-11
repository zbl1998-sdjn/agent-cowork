// Live artifact 授权读取(host · L1 领域层 · artifacts)
// ---------------------------------------------------------------------------
// 职责:在读取任何字节前校验成对 owner claim，再验证显式 live 契约与 HTML sentinel。
import {
  authorizeArtifactOwner,
  sameArtifactOwnerAuthorization,
} from './artifact-owner.js';
import {
  isLiveManifestForPath,
  readArtifactTextFile,
  validateJsonArtifactOwner,
} from './artifact-catalog-manifest.js';
import {
  hasLiveArtifactHtmlSentinel,
} from './live-artifact-contract.js';
import type {
  LIVE_ARTIFACT_SCHEMA_VERSION,
  LIVE_ARTIFACT_TYPE,
} from './live-artifact-contract.js';
import { artifactPaths, fail } from './live-spec.js';
import type { VizSpec } from './viz.js';

export type ArtifactManifest = {
  artifactType: typeof LIVE_ARTIFACT_TYPE;
  schemaVersion: typeof LIVE_ARTIFACT_SCHEMA_VERSION;
  id: string;
  title: string;
  kind?: string;
  viz: VizSpec;
  dataUrl: string;
  dataSource?: unknown;
  owner?: unknown;
  createdAt: string;
  lineageId?: string;
  parentVersionId?: string;
  contentSha256?: string;
};

export function readLiveArtifactPair({
  trustedRoot,
  id,
  context,
}: {
  trustedRoot: string;
  id: string;
  context?: unknown;
}): { manifest: ArtifactManifest; html: string } {
  const { htmlPath, manifestPath } = artifactPaths({ trustedRoot, id });
  const manifestAuthorization = authorizeArtifactOwner({
    trustedRoot,
    artifactPath: manifestPath,
    context,
  });
  const htmlAuthorization = authorizeArtifactOwner({
    trustedRoot,
    artifactPath: htmlPath,
    context,
  });
  if (!sameArtifactOwnerAuthorization(manifestAuthorization, htmlAuthorization)) {
    throw fail('artifact not found', 404);
  }
  const record = validateJsonArtifactOwner({
    trustedRoot,
    filePath: manifestPath,
    authorization: manifestAuthorization,
  });
  if (!isLiveManifestForPath(record, manifestPath)) throw fail('artifact not found', 404);
  const html = readArtifactTextFile(trustedRoot, htmlPath);
  if (!hasLiveArtifactHtmlSentinel(html)) throw fail('artifact not found', 404);
  return { manifest: record as unknown as ArtifactManifest, html };
}

export function readArtifactManifest({
  trustedRoot,
  id,
  context,
}: {
  trustedRoot: string;
  id: string;
  context?: unknown;
}): ArtifactManifest {
  return readLiveArtifactPair({ trustedRoot, id, context }).manifest;
}

export function readLiveArtifactHtml({
  trustedRoot,
  id,
  context,
}: {
  trustedRoot: string;
  id: string;
  context?: unknown;
}): string {
  return readLiveArtifactPair({ trustedRoot, id, context }).html;
}
