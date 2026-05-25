import path from 'node:path';

const PYTHON_TOOLS = new Set(['python', 'python3']);

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

export function resolveEmbeddedPython(toolName, sandbox, runtimeEnv = process.env) {
  if (!PYTHON_TOOLS.has(toolName) || !isLocalBackend(sandbox)) {
    return null;
  }

  const configuredExe = cleanConfiguredPath(runtimeEnv.KCW_EMBEDDED_PYTHON);
  if (configuredExe) {
    return { tool: path.basename(configuredExe), pathPrefix: path.dirname(configuredExe) };
  }

  const configuredHome = cleanConfiguredPath(runtimeEnv.KCW_PYTHON_HOME);
  if (!configuredHome) {
    return null;
  }
  return {
    tool: process.platform === 'win32' ? 'python.exe' : 'python',
    pathPrefix: configuredHome,
  };
}

export function withEmbeddedPythonLimits(sandboxLimits, embeddedTool) {
  const allowTools = sandboxLimits.allowTools
    ? Array.from(new Set([...sandboxLimits.allowTools, embeddedTool]))
    : null;
  return {
    ...sandboxLimits,
    allowTools,
    allowEnv: Array.from(new Set([...(sandboxLimits.allowEnv || []), 'PATH'])),
  };
}
