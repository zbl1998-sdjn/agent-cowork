// Exact write plan for publishing an immutable live-artifact version (host · L3 routes).
// Parent ownership, stored content hash, path jail, viz rendering, and data-source paths
// are all validated before an approval receipt can be issued.
import { verifyArtifactContentHash } from '../artifacts/artifact-version-chain.js';
import { readLiveArtifactPair } from '../artifacts/live-artifact-reader.js';
import {
  artifactPaths,
  fail,
  normalizeLiveArtifactSpec,
  resolveLiveArtifactDataSourcePath,
} from '../artifacts/live-spec.js';
import { renderViz } from '../artifacts/viz.js';
import { omitUndefined } from '../util/object.js';
import type { VizSpec } from '../artifacts/viz.js';

export type ArtifactVersionDraft = {
  id?: string | undefined;
  title?: string | undefined;
  viz?: VizSpec | undefined;
  dataSource?: unknown;
};

export type ArtifactVersionApprovalPlan = Readonly<{
  id: string;
  parentVersionId: string;
  parentContentSha256: string;
  lineageId: string;
  title: string;
  viz: VizSpec;
  dataSource: unknown;
  dataSourceType: string;
  relativePath: string;
  dataUrl: string;
  viewUrl: string;
  operations: ReadonlyArray<Readonly<Record<string, unknown>>>;
}>;

export function buildArtifactVersionApprovalPlan({
  trustedRoot,
  parentVersionId,
  draft,
  context,
  securityMode,
}: {
  trustedRoot: string;
  parentVersionId: string;
  draft: ArtifactVersionDraft;
  context?: unknown;
  securityMode?: unknown;
}): ArtifactVersionApprovalPlan {
  const parent = readLiveArtifactPair({ trustedRoot, id: parentVersionId, context });
  const parentIntegrity = verifyArtifactContentHash(parent, { requireStoredHash: true });
  const dataSource = Object.hasOwn(draft, 'dataSource')
    ? draft.dataSource
    : parent.manifest.dataSource;
  const spec = normalizeLiveArtifactSpec(omitUndefined({
    id: draft.id,
    title: draft.title ?? parent.manifest.title,
    viz: draft.viz ?? parent.manifest.viz,
    dataSource,
  }));
  if (spec.id === parent.manifest.id) {
    throw fail('new version id must differ from parent version id', 409);
  }
  renderViz(spec.viz, { securityMode });
  if (spec.dataSource?.type === 'file-json') {
    resolveLiveArtifactDataSourcePath({ trustedRoot, dataSource: spec.dataSource });
  }
  const paths = artifactPaths({ trustedRoot, id: spec.id });
  const lineageId = parent.manifest.lineageId || parent.manifest.id;
  const operation = {
    artifactId: spec.id,
    parentVersionId: parent.manifest.id,
    parentContentSha256: parentIntegrity.contentSha256,
    lineageId,
    title: spec.title,
    viz: spec.viz,
    dataUrl: spec.dataUrl,
    dataSource: spec.dataSource,
    securityMode: securityMode ?? null,
  };
  return Object.freeze({
    id: spec.id,
    parentVersionId: parent.manifest.id,
    parentContentSha256: parentIntegrity.contentSha256,
    lineageId,
    title: spec.title,
    viz: spec.viz,
    dataSource: spec.dataSource,
    dataSourceType: spec.dataSource?.type ?? 'inline',
    relativePath: paths.relativePath,
    dataUrl: spec.dataUrl,
    viewUrl: `/api/artifacts/live/${encodeURIComponent(spec.id)}`,
    operations: Object.freeze([
      Object.freeze({ ...operation, type: 'viz-artifact-version-html', path: paths.htmlPath }),
      Object.freeze({ ...operation, type: 'viz-artifact-version-manifest', path: paths.manifestPath }),
    ]),
  });
}
