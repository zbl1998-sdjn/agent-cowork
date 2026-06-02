// 实时制品·刷新阶段:读 manifest/html,并按数据源拉取最新 viz 数据(host · L1 领域层 · artifacts)
// ---------------------------------------------------------------------------
// 职责:实时制品流水线「规格→渲染→刷新」的末环——读取已落盘的 manifest/html,
//       再依数据源类型刷新数据:file-json 走同步读文件,connector-tool 走异步调用
//       受限的 MCP 工具(校验通过才放行),刷新后的数据交回前端重绘。
// 依赖:node:fs、viz(renderViz 校验数据)、live-spec(路径/数据源规范化与 fail)
// 导出:readArtifactManifest / readLiveArtifactHtml / refreshLiveArtifactData(同步) /
//       refreshLiveArtifactDataAsync(支持 connector-tool 的异步刷新)
import fs from 'node:fs';

import { omitUndefined } from '../util/object.js';
import { renderViz } from './viz.js';
import {
  artifactPaths,
  fail,
  normalizeLiveArtifactDataSource,
  resolveLiveArtifactDataSourcePath,
} from './live-spec.js';
import type { LiveArtifactDataSource } from './live-spec.js';
import type { VizSpec } from './viz.js';

export type ArtifactManifest = {
  id: string;
  title: string;
  viz: VizSpec;
  dataSource?: unknown;
};
export type ArtifactData = {
  id: string;
  title: string;
  viz: VizSpec;
  dataSource?: unknown;
  refreshedAt?: string;
};
export type ToolDescriptor = {
  source?: string;
  name?: string;
  risk?: unknown;
  mutating?: boolean;
  requiresApproval?: boolean;
};
export type ToolRegistryLike = {
  descriptor(name: string): ToolDescriptor | null | undefined;
  call(name: string, args: Record<string, unknown>, ctx: { trustedRoot: string; context?: unknown }): unknown | Promise<unknown>;
};

/** 读取并解析制品 manifest(JSON);文件不存在抛 404。 */
export function readArtifactManifest({ trustedRoot, id }: { trustedRoot: string; id: string }): ArtifactManifest {
  const { manifestPath } = artifactPaths({ trustedRoot, id });
  if (!fs.existsSync(manifestPath)) {
    throw fail('artifact not found', 404);
  }
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as ArtifactManifest;
}

/** 读取制品已落盘的活页 HTML 快照;文件不存在抛 404。 */
export function readLiveArtifactHtml({ trustedRoot, id }: { trustedRoot: string; id: string }): string {
  const { htmlPath } = artifactPaths({ trustedRoot, id });
  if (!fs.existsSync(htmlPath)) {
    throw fail('artifact not found', 404);
  }
  return fs.readFileSync(htmlPath, 'utf8');
}

/** 读取并解析 JSON 文件;区分「文件缺失(404)」与「内容非法 JSON(400)」两类错误。 */
function readJsonFile(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    const error = err as { code?: unknown };
    if (error && error.code === 'ENOENT') {
      throw fail('artifact data source not found', 404);
    }
    throw fail('artifact data source is not valid JSON');
  }
}

/** 从数据源载荷里取出 viz:优先取 payload.viz,否则把整个对象当作 viz。 */
function vizFromSourcePayload(payload: unknown): VizSpec {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    if (record.viz && typeof record.viz === 'object' && !Array.isArray(record.viz)) {
      return record.viz as VizSpec;
    }
    return record as VizSpec;
  }
  throw fail('artifact data source must contain a viz object');
}

/** file-json 数据源刷新:读本地 JSON 文件取 viz 并用 renderViz 验一遍后返回。 */
function refreshFromFileJson({
  trustedRoot,
  manifest,
  dataSource,
}: {
  trustedRoot: string;
  manifest: ArtifactManifest;
  dataSource: Extract<LiveArtifactDataSource, { type: 'file-json' }>;
}): ArtifactData {
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

/** 判定某 MCP 工具能否当实时数据源:放行只读 fs 读取,否则要求非变更、免审批、风险不高。 */
function connectorDataSourceAllowed(descriptor: ToolDescriptor | null | undefined): boolean {
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

/** 解析 MCP 工具返回:若是 content 数组则取其中的 text 片段当 JSON 解析,否则直接当对象。 */
function parseConnectorToolPayload(result: unknown): Record<string, unknown> {
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const record = result as { content?: unknown };
    if (Array.isArray(record.content)) {
      const textPart = record.content.find((part) => {
        const item = part && typeof part === 'object' ? part as { type?: unknown; text?: unknown } : {};
        return item.type === 'text' && typeof item.text === 'string';
      }) as { text: string } | undefined;
      if (!textPart) {
        throw fail('artifact connector data source must return text JSON');
      }
      try {
        return JSON.parse(textPart.text) as Record<string, unknown>;
      } catch {
        throw fail('artifact connector data source text is not valid JSON');
      }
    }
    return result as Record<string, unknown>;
  }
  throw fail('artifact connector data source must return a JSON object');
}

/** connector-tool 数据源刷新:校验工具已连接且被允许后调用它,解析返回里的 viz 并验证。 */
async function refreshFromConnectorTool({
  trustedRoot,
  manifest,
  dataSource,
  toolRegistry,
  context,
}: {
  trustedRoot: string;
  manifest: ArtifactManifest;
  dataSource: Extract<LiveArtifactDataSource, { type: 'connector-tool' }>;
  toolRegistry?: ToolRegistryLike | null;
  context?: unknown;
}): Promise<ArtifactData> {
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
  const payload = parseConnectorToolPayload(await toolRegistry.call(dataSource.tool, dataSource.args || {}, omitUndefined({
    trustedRoot,
    context,
  })));
  const viz = vizFromSourcePayload(payload);
  renderViz(viz);
  return {
    id: manifest.id,
    title: manifest.title,
    viz,
    dataSource,
  };
}

/** 同步刷新制品数据:connector-tool 需异步刷新故在此拒绝(503),file-json 读文件,无数据源回退 manifest 自带 viz。 */
export function refreshLiveArtifactData({ trustedRoot, id, now = new Date() }: { trustedRoot: string; id: string; now?: Date }): ArtifactData {
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

/** 异步刷新制品数据:三路分发——connector-tool 调工具、file-json 读文件、无数据源回退 manifest viz。 */
export async function refreshLiveArtifactDataAsync({
  trustedRoot,
  id,
  now = new Date(),
  toolRegistry,
  context,
}: {
  trustedRoot: string;
  id: string;
  now?: Date;
  toolRegistry?: ToolRegistryLike | null;
  context?: unknown;
}): Promise<ArtifactData> {
  const manifest = readArtifactManifest({ trustedRoot, id });
  const dataSource = normalizeLiveArtifactDataSource(manifest.dataSource);
  const base = dataSource?.type === 'connector-tool'
    ? await refreshFromConnectorTool(omitUndefined({ trustedRoot, manifest, dataSource, toolRegistry, context }))
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
