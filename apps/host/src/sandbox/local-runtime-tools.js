import path from 'node:path';

const PYTHON_TOOLS = new Set(['python', 'python3']);
const NODE_TOOLS = new Set(['node']);

function isLocalBackend(sandbox) {
  return /^local(?:-|$)/.test(String(sandbox?.backend || ''));
}

function cleanConfiguredPath(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw || raw.includes('\0') || !path.isAbsolute(raw)) {
    return '';
  }
  return raw;
}

function fromExecutable(exePath) {
  const clean = cleanConfiguredPath(exePath);
  return clean ? { tool: path.basename(clean), pathPrefix: path.dirname(clean) } : null;
}

function fromHome(homePath, exeName) {
  const clean = cleanConfiguredPath(homePath);
  return clean ? { tool: exeName, pathPrefix: clean } : null;
}

function resolvePython(toolName, runtimeEnv) {
  return fromExecutable(runtimeEnv.KCW_EMBEDDED_PYTHON)
    || fromHome(runtimeEnv.KCW_PYTHON_HOME, process.platform === 'win32' ? 'python.exe' : 'python');
}

function resolveNode(runtimeEnv, nodeExecPath) {
  const exeName = process.platform === 'win32' ? 'node.exe' : 'node';
  return fromExecutable(runtimeEnv.KCW_NODE_EXE)
    || fromHome(runtimeEnv.KCW_NODE_HOME, exeName)
    || fromExecutable(/(^|[/\\])node(\.exe)?$/i.test(nodeExecPath || '') ? nodeExecPath : '');
}

export function resolveLocalRuntimeTool(toolName, sandbox, runtimeEnv = process.env, nodeExecPath = process.execPath) {
  if (!isLocalBackend(sandbox)) return null;
  if (PYTHON_TOOLS.has(toolName)) return resolvePython(toolName, runtimeEnv);
  if (NODE_TOOLS.has(toolName)) return resolveNode(runtimeEnv, nodeExecPath);
  return null;
}

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
