// 实时制品·规格阶段:生成/校验制品 id、解析数据源、规范化 live 制品 spec(host · L1 领域层 · artifacts)
// ---------------------------------------------------------------------------
// 职责:实时制品流水线的「规格→渲染→刷新」中的第一环——把外部传入的 spec 收口成
//       受信任的内部形状:校验 id、定位带围栏的 html/manifest 路径、规范化 file-json /
//       connector-tool 两类数据源,并补默认 dataUrl。
// 依赖:node:crypto(随机 id)、node:path、security/path-policy(路径围栏)
// 导出:fail / createArtifactId / assertArtifactId / artifactDir / artifactPaths /
//       normalizeLiveArtifactDataSource / resolveLiveArtifactDataSourcePath / normalizeLiveArtifactSpec
//       及常量 ART_PARTS、CHART_KINDS
import crypto from 'node:crypto';
import path from 'node:path';

import { assertTrustedPath } from '../security/path-policy.js';
import { omitUndefined } from '../util/object.js';

export type HttpError = Error & { statusCode?: number };
export type LiveArtifactDataSource =
  | { type: 'file-json'; path: string }
  | { type: 'connector-tool'; tool: string; args: Record<string, unknown> };
export type VizSpec = { kind?: string; [key: string]: unknown };
export type LiveArtifactSpecInput = {
  id?: string;
  title?: string;
  viz?: VizSpec;
  dataUrl?: string;
  dataSource?: unknown;
};
export type NormalizedLiveArtifactSpec = {
  id: string;
  title: string;
  kind?: string;
  viz: VizSpec;
  dataUrl: string;
  dataSource: LiveArtifactDataSource | null;
};

export const ART_PARTS = ['.AgentCowork', 'artifacts'];
export const CHART_KINDS = new Set(['bar', 'line', 'pie', 'doughnut']);

const ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/** 构造带 statusCode 的制品错误(消息统一加 "artifact: " 前缀)。 */
export function fail(message: string, statusCode = 400): HttpError {
  const error = new Error(`artifact: ${message}`) as HttpError;
  error.statusCode = statusCode;
  return error;
}

/** 生成制品 id:时间戳前缀 + 随机 8 位,形如 viz_YYYYMMDDhhmmss_xxxxxxxx。 */
export function createArtifactId(now = new Date()): string {
  const ts = now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `viz_${ts}_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
}

/** 校验 id 只含 [a-zA-Z0-9_-] 且长度 1..64,防止被用作路径注入。 */
export function assertArtifactId(id: string): string {
  if (!ID_RE.test(id || '')) {
    throw fail('invalid artifact id');
  }
  return id;
}

/** 返回受围栏保护的工作根及其下的制品目录(.AgentCowork/artifacts)。 */
export function artifactDir(trustedRoot: string): { safeRoot: string; dir: string } {
  const safeRoot = assertTrustedPath(path.resolve(trustedRoot), path.resolve(trustedRoot));
  return { safeRoot, dir: path.join(safeRoot, ...ART_PARTS) };
}

/** 由 id 推导该制品的 html / manifest 绝对路径与对外相对路径,均经路径围栏。 */
export function artifactPaths({ trustedRoot, id }: { trustedRoot: string; id: string }): {
  artifactId: string;
  dir: string;
  htmlPath: string;
  manifestPath: string;
  relativePath: string;
} {
  const artifactId = assertArtifactId(id);
  const { dir } = artifactDir(trustedRoot);
  const root = path.resolve(trustedRoot);
  return {
    artifactId,
    dir,
    htmlPath: assertTrustedPath(path.join(dir, `${artifactId}.html`), root),
    manifestPath: assertTrustedPath(path.join(dir, `${artifactId}.json`), root),
    relativePath: [...ART_PARTS, `${artifactId}.html`].join('/'),
  };
}

/** 规范化数据源:仅接受 file-json(相对路径)或 connector-tool(已连接的 MCP 工具),其余报错。 */
export function normalizeLiveArtifactDataSource(dataSource: unknown): LiveArtifactDataSource | null {
  if (dataSource == null) {
    return null;
  }
  if (!dataSource || typeof dataSource !== 'object' || Array.isArray(dataSource)) {
    throw fail('dataSource must be an object');
  }
  const record = dataSource as Record<string, unknown>;
  const type = String(record.type || record.kind || '').toLowerCase();
  if (type === 'connector-tool') {
    const tool = String(record.tool || record.name || '').trim();
    if (!/^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_.-]+$/.test(tool)) {
      throw fail('dataSource.tool must be a connected MCP tool name');
    }
    const args = record.args == null ? {} : record.args;
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      throw fail('dataSource.args must be an object');
    }
    return {
      type: 'connector-tool',
      tool,
      // 深拷贝并丢弃函数/原型等不可序列化内容,得到纯净可入库的参数对象
      args: JSON.parse(JSON.stringify(args)) as Record<string, unknown>,
    };
  }
  if (type !== 'file-json') {
    throw fail(`unsupported artifact data source "${type || '(empty)'}"`);
  }
  const sourcePath = String(record.path || '').trim();
  if (!sourcePath) {
    throw fail('dataSource.path is required');
  }
  if (path.isAbsolute(sourcePath)) {
    throw fail('dataSource.path must be relative to trustedRoot');
  }
  return {
    type: 'file-json',
    path: sourcePath.replace(/\\/g, '/'),
  };
}

/** 把 file-json 数据源的相对路径解析为受围栏保护的绝对路径(非 file-json 返回 null)。 */
export function resolveLiveArtifactDataSourcePath({ trustedRoot, dataSource }: { trustedRoot: string; dataSource: unknown }): string | null {
  const source = normalizeLiveArtifactDataSource(dataSource);
  if (!source || source.type !== 'file-json') {
    return null;
  }
  const root = path.resolve(trustedRoot);
  return assertTrustedPath(path.join(root, source.path), root);
}

/** 规范化整份 live 制品 spec:校验 viz、补 id/title/dataUrl 默认值、收口 dataSource。 */
export function normalizeLiveArtifactSpec({ id, title, viz, dataUrl, dataSource }: LiveArtifactSpecInput = {}): NormalizedLiveArtifactSpec {
  if (!viz || typeof viz !== 'object') {
    throw fail('viz spec is required');
  }
  const artifactId = id ? assertArtifactId(id) : createArtifactId();
  const resolvedDataUrl = dataUrl || `/api/artifacts/data/${artifactId}`;
  return omitUndefined({
    id: artifactId,
    title: title || '活页 Artifact',
    kind: viz.kind,
    viz,
    dataUrl: resolvedDataUrl,
    dataSource: normalizeLiveArtifactDataSource(dataSource),
  });
}
