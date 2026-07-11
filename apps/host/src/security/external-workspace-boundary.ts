// 外部工作区路径边界(host · L0 基础层 · security)
// ---------------------------------------------------------------------------
// 职责:阻断外部文件能力直接访问 `.AgentCowork` 内部状态；仅把 artifacts 子树交给
//       上层 owner guard。内部存储代码不调用本模块，因此仍可读写自身元数据。
import path from 'node:path';

import {
  assertTrustedPathForCreate,
  canonicalizePath,
} from './path-policy.js';

const INTERNAL_DIR = '.AgentCowork';
const ARTIFACT_DIR = 'artifacts';

type ExternalWorkspacePathKind = 'public' | 'internal-container' | 'artifact-container' | 'artifact' | 'internal';

function segmentEquals(left: string | undefined, right: string): boolean {
  if (left === undefined) return false;
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function pathSegments(input: string): string[] {
  return path.resolve(input).split(/[\\/]+/u).filter(Boolean);
}

function internalPathNotFound(): Error & { statusCode: number } {
  const error = new Error('workspace path not found') as Error & { statusCode: number };
  error.statusCode = 404;
  return error;
}

function classifyResolvedPath(safePath: string, safeRoot: string): ExternalWorkspacePathKind {
  const relative = path.relative(safeRoot, safePath);
  if (!relative) return 'public';
  const parts = relative.split(path.sep).filter(Boolean);
  if (!segmentEquals(parts[0], INTERNAL_DIR)) return 'public';
  if (parts.length === 1) return 'internal-container';
  if (!segmentEquals(parts[1], ARTIFACT_DIR)) return 'internal';
  if (parts.length === 2) return 'artifact-container';
  return 'artifact';
}

function lexicalPath(candidatePath: string, safeRoot: string): string {
  return path.isAbsolute(candidatePath)
    ? path.resolve(candidatePath)
    : path.resolve(safeRoot, candidatePath);
}

function directExposureAllowed(
  lexical: ExternalWorkspacePathKind,
  resolved: ExternalWorkspacePathKind,
): boolean {
  if (lexical !== 'public' && lexical !== 'artifact') return false;
  if (resolved !== 'public' && resolved !== 'artifact') return false;
  return lexical !== 'artifact' || resolved === 'artifact';
}

/** 外部调用不可把 `.AgentCowork` 自身或其后代重新解释成一个新工作区根。 */
export function assertExternalWorkspaceRoot(trustedRoot: string): string {
  const lexicalRoot = path.resolve(trustedRoot);
  const safeRoot = canonicalizePath(trustedRoot);
  if ([lexicalRoot, safeRoot].some((candidate) => (
    pathSegments(candidate).some((segment) => segmentEquals(segment, INTERNAL_DIR))
  ))) {
    throw internalPathNotFound();
  }
  return safeRoot;
}

/** 外部直达路径只允许普通工作区文件或 artifacts 后代；两个保留容器本身也不可直达。 */
export function assertExternalWorkspacePath(candidatePath: string, trustedRoot: string): string {
  const safeRoot = assertExternalWorkspaceRoot(trustedRoot);
  const lexical = classifyResolvedPath(lexicalPath(candidatePath, safeRoot), safeRoot);
  const safePath = assertTrustedPathForCreate(candidatePath, safeRoot);
  const resolved = classifyResolvedPath(safePath, safeRoot);
  if (!directExposureAllowed(lexical, resolved)) throw internalPathNotFound();
  return safePath;
}

/** 遍历时保留 `.AgentCowork/artifacts` 两层容器，但隐藏其他内部分支与非目录伪装。 */
export function externalWorkspaceEntryAllowed(
  candidatePath: string,
  trustedRoot: string,
  kind: 'file' | 'directory',
): boolean {
  try {
    const safeRoot = assertExternalWorkspaceRoot(trustedRoot);
    const lexical = classifyResolvedPath(lexicalPath(candidatePath, safeRoot), safeRoot);
    const safePath = assertTrustedPathForCreate(candidatePath, safeRoot);
    const resolved = classifyResolvedPath(safePath, safeRoot);
    if (directExposureAllowed(lexical, resolved)) return true;
    return kind === 'directory' && lexical === resolved
      && (lexical === 'internal-container' || lexical === 'artifact-container');
  } catch {
    return false;
  }
}
