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

/** @param {SandboxLimits} sandboxLimits @param {string} runtimeTool @returns {SandboxLimits} */
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
