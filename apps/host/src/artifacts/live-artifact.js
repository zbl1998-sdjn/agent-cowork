// @ts-check
import fs from 'node:fs';

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

export {
  createArtifactId,
  renderLivePage,
  readArtifactManifest,
  readLiveArtifactHtml,
  refreshLiveArtifactData,
  refreshLiveArtifactDataAsync,
};

/**
 * @typedef {import('./viz.js').VizSpec} VizSpec
 * @typedef {{ trustedRoot: string, id?: string, title?: string, viz: VizSpec, dataUrl?: string, dataSource?: unknown }} BuildLiveArtifactOptions
 * @typedef {{ id: string, htmlPath: string, manifestPath: string, relativePath: string, dataUrl: string }} BuiltLiveArtifact
 */

/** @param {BuildLiveArtifactOptions} options @returns {BuiltLiveArtifact} */
export function buildLiveArtifact({ trustedRoot, id, title, viz, dataUrl, dataSource }) {
  const spec = normalizeLiveArtifactSpec({ id, title, viz, dataUrl, dataSource });
  // Validate the viz spec by rendering it once (throws 400 on bad kind/data).
  renderViz(spec.viz);
  if (spec.dataSource?.type === 'file-json') {
    resolveLiveArtifactDataSourcePath({ trustedRoot, dataSource: spec.dataSource });
  }

  const { dir, htmlPath, manifestPath, relativePath } = artifactPaths({ trustedRoot, id: spec.id });
  fs.mkdirSync(dir, { recursive: true });

  const html = renderLivePage({ title: spec.title, viz: spec.viz, dataUrl: spec.dataUrl });
  const manifest = {
    id: spec.id,
    title: spec.title,
    kind: spec.kind,
    viz: spec.viz,
    dataUrl: spec.dataUrl,
    dataSource: spec.dataSource || undefined,
    createdAt: new Date().toISOString(),
  };
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
