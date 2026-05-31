// 本地运行时工具解析(host · L1 领域层 · sandbox)
// ---------------------------------------------------------------------------
// 职责:仅在本地后端下,把 python/node 解析到「随应用打包/配置」的运行时(内置 Python、
//       指定 Node),以便离线/免装即可跑代码;并据此收窄沙箱限额(把该运行时与 PATH 加进白名单)。
// 依赖:node:path。导出:resolveLocalRuntimeTool / withLocalRuntimeToolLimits。

import path from 'node:path';

/**
 * @typedef {{ backend?: unknown }} SandboxLike
 * @typedef {Record<string, string | undefined>} RuntimeEnv
 * @typedef {{ tool: string, pathPrefix: string }} LocalRuntimeTool
 * @typedef {{ allowTools?: string[] | null, allowEnv?: string[] }} SandboxLimits
 */

const PYTHON_TOOLS = new Set(['python', 'python3']);
const NODE_TOOLS = new Set(['node']);

/** @param {SandboxLike | null | undefined} sandbox @returns {boolean} */
function isLocalBackend(sandbox) {
  return /^local(?:-|$)/.test(String(sandbox?.backend || ''));
}

/** @param {unknown} value @returns {string} */
function cleanConfiguredPath(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw || raw.includes('\0') || !path.isAbsolute(raw)) {
    return '';
  }
  return raw;
}

/** @param {unknown} exePath @returns {LocalRuntimeTool | null} */
function fromExecutable(exePath) {
  const clean = cleanConfiguredPath(exePath);
  return clean ? { tool: path.basename(clean), pathPrefix: path.dirname(clean) } : null;
}

/** @param {unknown} homePath @param {string} exeName @returns {LocalRuntimeTool | null} */
function fromHome(homePath, exeName) {
  const clean = cleanConfiguredPath(homePath);
  return clean ? { tool: exeName, pathPrefix: clean } : null;
}

/** @param {string} toolName @param {RuntimeEnv} runtimeEnv @returns {LocalRuntimeTool | null} */
function resolvePython(toolName, runtimeEnv) {
  return fromExecutable(runtimeEnv.KCW_EMBEDDED_PYTHON)
    || fromHome(runtimeEnv.KCW_PYTHON_HOME, process.platform === 'win32' ? 'python.exe' : 'python');
}

/** @param {RuntimeEnv} runtimeEnv @param {unknown} nodeExecPath @returns {LocalRuntimeTool | null} */
function resolveNode(runtimeEnv, nodeExecPath) {
  const exeName = process.platform === 'win32' ? 'node.exe' : 'node';
  const execPath = typeof nodeExecPath === 'string' ? nodeExecPath : '';
  return fromExecutable(runtimeEnv.KCW_NODE_EXE)
    || fromHome(runtimeEnv.KCW_NODE_HOME, exeName)
    || fromExecutable(/(^|[/\\])node(\.exe)?$/i.test(execPath) ? execPath : '');
}

/**
 * 解析本地运行时工具:本地后端下把 python/node 映射到内置/配置的可执行文件(返回 { tool, pathPrefix });否则 null。
 * @param {string} toolName
 * @param {SandboxLike | null | undefined} sandbox
 * @param {RuntimeEnv} [runtimeEnv]
 * @param {unknown} [nodeExecPath]
 * @returns {LocalRuntimeTool | null}
 */
export function resolveLocalRuntimeTool(toolName, sandbox, runtimeEnv = process.env, nodeExecPath = process.execPath) {
  if (!isLocalBackend(sandbox)) return null;
  if (PYTHON_TOOLS.has(toolName)) return resolvePython(toolName, runtimeEnv);
  if (NODE_TOOLS.has(toolName)) return resolveNode(runtimeEnv, nodeExecPath);
  return null;
}

/** 在原限额基础上,把选中的本地运行时工具与 PATH 并入白名单(内置 Python 不得借机放宽调用方白名单)。 @param {SandboxLimits} sandboxLimits @param {string} runtimeTool @returns {SandboxLimits} */
export function withLocalRuntimeToolLimits(sandboxLimits, runtimeTool) {
  const allowTools = sandboxLimits.allowTools
    ? Array.from(new Set([...sandboxLimits.allowTools, runtimeTool]))
    : null;
  return {
    ...sandboxLimits,
    allowTools,
    allowEnv: Array.from(new Set([...(sandboxLimits.allowEnv || []), 'PATH'])),
  };
}
