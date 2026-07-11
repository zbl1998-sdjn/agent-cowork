// 实时制品门面:串起「规格→渲染→刷新」并把活页 HTML + manifest 落盘(host · L1 领域层 · artifacts)
// ---------------------------------------------------------------------------
// 职责:实时制品流水线的入口与聚合层——buildLiveArtifact 调 live-spec 规格化、
//       viz 校验、live-render 出 HTML、再写盘 manifest;并把 live-spec/render/refresh
//       的读取与刷新函数原样转出,供路由层使用。
// 依赖:node:fs、viz、live-spec、live-render、live-refresh(均为同层 artifacts 模块)
// 导出:buildLiveArtifact 及再导出的 createArtifactId / renderLivePage / readArtifactManifest /
//       readLiveArtifactHtml / refreshLiveArtifactData / refreshLiveArtifactDataAsync
import { omitUndefined } from '../util/object.js';
import { artifactOwnerMetadata } from './artifact-owner.js';
import {
  LIVE_ARTIFACT_SCHEMA_VERSION,
  LIVE_ARTIFACT_TYPE,
} from './live-artifact-contract.js';
import { createLiveArtifactTransaction } from './live-artifact-transaction.js';
import {
  computeArtifactContentSha256,
  verifyArtifactContentHash,
} from './artifact-version-chain.js';
import { readLiveArtifactPair } from './live-artifact-reader.js';
import { renderViz } from './viz.js';
import {
  ART_PARTS,
  createArtifactId,
  normalizeLiveArtifactSpec,
  artifactPaths,
  fail,
  resolveLiveArtifactDataSourcePath,
} from './live-spec.js';
import { renderLivePage } from './live-render.js';
import {
  readArtifactManifest,
  readLiveArtifactHtml,
  refreshLiveArtifactData,
  refreshLiveArtifactDataAsync,
} from './live-refresh.js';
import type { LiveArtifactDataSource } from './live-spec.js';
import type { VizSpec } from './viz.js';
import type { ArtifactOwnerMetadata } from './artifact-owner.js';

export {
  createArtifactId,
  renderLivePage,
  readArtifactManifest,
  readLiveArtifactHtml,
  refreshLiveArtifactData,
  refreshLiveArtifactDataAsync,
};

export type BuildLiveArtifactOptions = {
  trustedRoot: string;
  id?: string;
  title?: string;
  viz: VizSpec;
  dataUrl?: string;
  dataSource?: unknown;
  securityMode?: unknown;
  owner?: unknown;
};

export type BuiltLiveArtifact = {
  id: string;
  htmlPath: string;
  manifestPath: string;
  relativePath: string;
  dataUrl: string;
};

export type BuildLiveArtifactVersionOptions = Omit<BuildLiveArtifactOptions, 'id' | 'owner'> & {
  id: string;
  parentVersionId: string;
  context?: unknown;
};

type LiveArtifactManifest = {
  artifactType: typeof LIVE_ARTIFACT_TYPE;
  schemaVersion: typeof LIVE_ARTIFACT_SCHEMA_VERSION;
  id: string;
  title: string;
  kind?: string;
  viz: VizSpec;
  dataUrl: string;
  dataSource?: LiveArtifactDataSource;
  owner?: ArtifactOwnerMetadata;
  createdAt: string;
  lineageId: string;
  parentVersionId?: string;
  contentSha256: string;
};

function publishLiveArtifact({
  trustedRoot,
  id,
  title,
  viz,
  dataUrl,
  dataSource,
  securityMode,
  owner,
}: BuildLiveArtifactOptions, {
  lineageId,
  parentVersionId,
}: {
  lineageId?: string;
  parentVersionId?: string;
} = {}): BuiltLiveArtifact {
  const spec = normalizeLiveArtifactSpec(omitUndefined({ id, title, viz, dataUrl, dataSource }));
  // 先渲染一次校验 viz 规格;类型或数据不合法会抛 400。
  renderViz(spec.viz, { securityMode });
  if (spec.dataSource?.type === 'file-json') {
    resolveLiveArtifactDataSourcePath({ trustedRoot, dataSource: spec.dataSource });
  }

  const { dir, htmlPath, manifestPath, relativePath } = artifactPaths({ trustedRoot, id: spec.id });
  const html = renderLivePage({ title: spec.title, viz: spec.viz, dataUrl: spec.dataUrl, securityMode });
  const manifestBase = omitUndefined({
    artifactType: LIVE_ARTIFACT_TYPE,
    schemaVersion: LIVE_ARTIFACT_SCHEMA_VERSION,
    id: spec.id,
    title: spec.title,
    kind: spec.kind,
    viz: spec.viz,
    dataUrl: spec.dataUrl,
    dataSource: spec.dataSource || undefined,
    owner: owner === undefined
      ? undefined
      : artifactOwnerMetadata({ trustedRoot, artifactPath: manifestPath, owner }),
    createdAt: new Date().toISOString(),
    lineageId: lineageId || spec.id,
    parentVersionId,
  }) as Omit<LiveArtifactManifest, 'contentSha256'>;
  const manifest: LiveArtifactManifest = {
    ...manifestBase,
    contentSha256: computeArtifactContentSha256(manifestBase as LiveArtifactManifest, html),
  };
  const transaction = createLiveArtifactTransaction({
    trustedRoot,
    artifactDir: dir,
    htmlPath,
    manifestPath,
    owner,
  });
  try {
    if (!transaction.publish(htmlPath, html)) {
      throw fail('artifact already exists', 409);
    }
    if (!transaction.publish(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)) {
      throw fail('artifact already exists', 409);
    }
  } catch (error) {
    transaction.rollback(error);
  }
  return {
    id: spec.id,
    htmlPath,
    manifestPath,
    relativePath: relativePath || [...ART_PARTS, `${spec.id}.html`].join('/'),
    dataUrl: spec.dataUrl,
  };
}

/** 构建一份初始实时制品；新制品自成 lineage，文件仍由 write-once 事务发布。 */
export function buildLiveArtifact(options: BuildLiveArtifactOptions): BuiltLiveArtifact {
  return publishLiveArtifact(options);
}

/** 从已验证父版本发布新 ID；父 pair、owner 和内容哈希全部在任何写入发生前校验。 */
export function buildLiveArtifactVersion(options: BuildLiveArtifactVersionOptions): BuiltLiveArtifact {
  const { trustedRoot, parentVersionId, id, context, title, viz, dataUrl, securityMode } = options;
  if (id === parentVersionId) throw fail('new version id must differ from parent version id', 409);
  const parent = readLiveArtifactPair({ trustedRoot, id: parentVersionId, context });
  verifyArtifactContentHash(parent, { requireStoredHash: true });
  const dataSource = Object.prototype.hasOwnProperty.call(options, 'dataSource')
    ? options.dataSource
    : parent.manifest.dataSource;
  return publishLiveArtifact(omitUndefined({
    trustedRoot,
    id,
    title: title ?? parent.manifest.title,
    viz,
    dataUrl,
    dataSource,
    securityMode,
    owner: context,
  }) as BuildLiveArtifactOptions, {
    lineageId: parent.manifest.lineageId || parent.manifest.id,
    parentVersionId: parent.manifest.id,
  });
}
