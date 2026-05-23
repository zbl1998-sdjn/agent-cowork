// Structured execution spec for the sandbox.
//
// The sandbox never accepts a raw shell string. Callers describe *what* to run
// as structured data: a tool name (resolved on PATH / inside the VM image),
// an argv array, an optional cwd jailed to the trusted root, a required time
// budget, an env allowlist, and an explicit network flag (default off). With
// `shell: false` at the spawn layer, argv values cannot inject shell syntax,
// so validation focuses on the tool name and the resource bounds.

const MAX_ARGS = 64;
const MAX_ARG_LENGTH = 8192;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
const TOOL_RE = /^[a-zA-Z0-9_.-]{1,64}$/;
const NUL = String.fromCharCode(0);

function fail(message) {
  const error = new Error(`sandbox spec: ${message}`);
  error.statusCode = 400;
  return error;
}

function cleanArg(value, index) {
  if (typeof value !== 'string') {
    throw fail(`args[${index}] must be a string`);
  }
  if (value.length > MAX_ARG_LENGTH) {
    throw fail(`args[${index}] too long (max ${MAX_ARG_LENGTH})`);
  }
  if (value.includes(NUL)) {
    throw fail(`args[${index}] contains a NUL byte`);
  }
  return value;
}

function cleanEnv(env, allowEnv) {
  if (env == null) {
    return {};
  }
  if (typeof env !== 'object' || Array.isArray(env)) {
    throw fail('env must be an object');
  }
  const allow = new Set(allowEnv || []);
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw fail(`env key "${key}" is not a valid variable name`);
    }
    if (!allow.has(key)) {
      throw fail(`env key "${key}" is not in the allowlist`);
    }
    if (typeof value !== 'string') {
      throw fail(`env["${key}"] must be a string`);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Validate + normalise a raw spec into a safe, fully-defaulted spec.
 *
 * @param {object} input raw caller spec
 * @param {object} [limits] { allowTools, allowEnv, maxTimeoutMs, defaultMaxOutputBytes }
 * @returns normalised spec: { tool, args, cwd, timeoutMs, network, env, maxOutputBytes }
 */
export function normalizeSandboxSpec(input, limits = {}) {
  const spec = input || {};
  const allowTools = limits.allowTools || null; // null => any TOOL_RE-valid name
  const maxTimeoutMs = Math.min(Number(limits.maxTimeoutMs) || MAX_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const maxOutputBytes = Number(limits.defaultMaxOutputBytes) || DEFAULT_MAX_OUTPUT_BYTES;

  const tool = String(spec.tool || '').trim();
  if (!tool) {
    throw fail('tool is required');
  }
  if (!TOOL_RE.test(tool)) {
    throw fail('tool must be a bare command name (no path separators or special chars)');
  }
  if (allowTools && !allowTools.includes(tool)) {
    throw fail(`tool "${tool}" is not in the allowlist`);
  }

  const rawArgs = spec.args == null ? [] : spec.args;
  if (!Array.isArray(rawArgs)) {
    throw fail('args must be an array');
  }
  if (rawArgs.length > MAX_ARGS) {
    throw fail(`too many args (max ${MAX_ARGS})`);
  }
  const args = rawArgs.map(cleanArg);

  let timeoutMs = spec.timeoutMs == null ? DEFAULT_TIMEOUT_MS : Number(spec.timeoutMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw fail('timeoutMs must be a positive number');
  }
  timeoutMs = Math.min(Math.floor(timeoutMs), maxTimeoutMs);

  const cwd = spec.cwd == null ? '' : String(spec.cwd);
  if (cwd.includes(NUL)) {
    throw fail('cwd contains a NUL byte');
  }

  const network = spec.network === true; // default off
  const env = cleanEnv(spec.env, limits.allowEnv);

  return { tool, args, cwd, timeoutMs, network, env, maxOutputBytes };
}

export const SANDBOX_DEFAULTS = Object.freeze({
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
});
