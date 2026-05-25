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

function connectorDataSourceAllowed(descriptor) {
  if (!descriptor) {
    return false;
  }
  if (descriptor.source === 'mcp:fs' && descriptor.name === 'mcp__fs__read_text') {
    return true;
  }
  const risk = String(descriptor.risk || '').toLowerCase();
  return descriptor.mutating !== true
    && descriptor.requiresApproval !== true
    && !['high', 'critical'].includes(risk);
}

function parseConnectorToolPayload(result) {
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    if (Array.isArray(result.content)) {
      const textPart = result.content.find((part) => part && part.type === 'text' && typeof part.text === 'string');
      if (!textPart) {
        throw fail('artifact connector data source must return text JSON');
      }
      try {
        return JSON.parse(textPart.text);
      } catch {
        throw fail('artifact connector data source text is not valid JSON');
      }
    }
    return result;
  }
  throw fail('artifact connector data source must return a JSON object');
}

async function refreshFromConnectorTool({ trustedRoot, manifest, dataSource, toolRegistry, context }) {
  if (!toolRegistry) {
    throw fail('artifact connector data source is unavailable', 503);
  }
  const descriptor = toolRegistry.descriptor(dataSource.tool);
  if (!descriptor) {
    throw fail('artifact connector tool is not connected', 409);
  }
  if (!connectorDataSourceAllowed(descriptor)) {
    throw fail('artifact connector tool is not allowed as a live data source', 403);
  }
  const payload = parseConnectorToolPayload(await toolRegistry.call(dataSource.tool, dataSource.args || {}, {
    trustedRoot,
    context,
  }));
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
  if (dataSource?.type === 'connector-tool') {
    throw fail('artifact connector data source requires async refresh', 503);
  }
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

export async function refreshLiveArtifactDataAsync({ trustedRoot, id, now = new Date(), toolRegistry, context }) {
  const manifest = readArtifactManifest({ trustedRoot, id });
  const dataSource = normalizeLiveArtifactDataSource(manifest.dataSource);
  const base = dataSource?.type === 'connector-tool'
    ? await refreshFromConnectorTool({ trustedRoot, manifest, dataSource, toolRegistry, context })
    : dataSource
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
