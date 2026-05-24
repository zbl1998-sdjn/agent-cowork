import fs from 'node:fs';

import { renderViz } from './viz.js';
import {
  artifactPaths,
  fail,
  normalizeLiveArtifactDataSource,
  resolveLiveArtifactDataSourcePath,
} from './live-spec.js';

export function readArtifactManifest({ trustedRoot, id }) {
  const { manifestPath } = artifactPaths({ trustedRoot, id });
  if (!fs.existsSync(manifestPath)) {
    throw fail('artifact not found', 404);
  }
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

export function readLiveArtifactHtml({ trustedRoot, id }) {
  const { htmlPath } = artifactPaths({ trustedRoot, id });
  if (!fs.existsSync(htmlPath)) {
    throw fail('artifact not found', 404);
  }
  return fs.readFileSync(htmlPath, 'utf8');
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      throw fail('artifact data source not found', 404);
    }
    throw fail('artifact data source is not valid JSON');
  }
}

function vizFromSourcePayload(payload) {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    if (payload.viz && typeof payload.viz === 'object' && !Array.isArray(payload.viz)) {
      return payload.viz;
    }
    return payload;
  }
  throw fail('artifact data source must contain a viz object');
}

function refreshFromFileJson({ trustedRoot, manifest, dataSource }) {
  const filePath = resolveLiveArtifactDataSourcePath({ trustedRoot, dataSource });
  if (!filePath || !fs.existsSync(filePath)) {
    throw fail('artifact data source not found', 404);
  }
  const payload = readJsonFile(filePath);
  const viz = vizFromSourcePayload(payload);
  renderViz(viz);
  return {
    id: manifest.id,
    title: manifest.title,
    viz,
    dataSource,
  };
}

export function refreshLiveArtifactData({ trustedRoot, id, now = new Date() }) {
  const manifest = readArtifactManifest({ trustedRoot, id });
  const dataSource = normalizeLiveArtifactDataSource(manifest.dataSource);
  const base = dataSource
    ? refreshFromFileJson({ trustedRoot, manifest, dataSource })
    : {
        id: manifest.id,
        title: manifest.title,
        viz: manifest.viz,
      };
  return {
    ...base,
    refreshedAt: now.toISOString(),
  };
}
