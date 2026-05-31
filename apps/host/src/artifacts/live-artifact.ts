// 实时制品门面:串起「规格→渲染→刷新」并把活页 HTML + manifest 落盘(host · L1 领域层 · artifacts)
// ---------------------------------------------------------------------------
// 职责:实时制品流水线的入口与聚合层——buildLiveArtifact 调 live-spec 规格化、
//       viz 校验、live-render 出 HTML、再写盘 manifest;并把 live-spec/render/refresh
//       的读取与刷新函数原样转出,供路由层使用。
// 依赖:node:fs、viz、live-spec、live-render、live-refresh(均为同层 artifacts 模块)
// 导出:buildLiveArtifact 及再导出的 createArtifactId / renderLivePage / readArtifactManifest /
//       readLiveArtifactHtml / refreshLiveArtifactData / refreshLiveArtifactDataAsync
import fs from 'node:fs';

import { omitUndefined } from '../util/object.js';
import { renderViz } from './viz.js';
import {
  ART_PARTS,
  createArtifactId,
  normalizeLiveArtifactSpec,
  artifactPaths,
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
};

export type BuiltLiveArtifact = {
  id: string;
  htmlPath: string;
  manifestPath: string;
  relativePath: string;
  dataUrl: string;
};

type LiveArtifactManifest = {
  id: string;
  title: string;
  kind?: string;
  viz: VizSpec;
  dataUrl: string;
  dataSource?: LiveArtifactDataSource;
  createdAt: string;
};

/** 构建一份实时制品:规格化 spec → 试渲染校验 → 写出活页 HTML 与 manifest,返回落盘路径与 dataUrl。 */
export function buildLiveArtifact({ trustedRoot, id, title, viz, dataUrl, dataSource }: BuildLiveArtifactOptions): BuiltLiveArtifact {
  const spec = normalizeLiveArtifactSpec(omitUndefined({ id, title, viz, dataUrl, dataSource }));
  // Validate the viz spec by rendering it once (throws 400 on bad kind/data).
  renderViz(spec.viz);
  if (spec.dataSource?.type === 'file-json') {
    resolveLiveArtifactDataSourcePath({ trustedRoot, dataSource: spec.dataSource });
  }

  const { dir, htmlPath, manifestPath, relativePath } = artifactPaths({ trustedRoot, id: spec.id });
  fs.mkdirSync(dir, { recursive: true });

  const html = renderLivePage({ title: spec.title, viz: spec.viz, dataUrl: spec.dataUrl });
  const manifest: LiveArtifactManifest = omitUndefined({
    id: spec.id,
    title: spec.title,
    kind: spec.kind,
    viz: spec.viz,
    dataUrl: spec.dataUrl,
    dataSource: spec.dataSource || undefined,
    createdAt: new Date().toISOString(),
  });
  fs.writeFileSync(htmlPath, html, 'utf8');
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return {
    id: spec.id,
    htmlPath,
    manifestPath,
    relativePath: relativePath || [...ART_PARTS, `${spec.id}.html`].join('/'),
    dataUrl: spec.dataUrl,
  };
}
