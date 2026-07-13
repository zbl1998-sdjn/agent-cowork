// 沙箱执行规格(host · L1 领域层 · sandbox)
// ---------------------------------------------------------------------------
// 职责:沙箱「绝不」接受裸 shell 字符串。调用方以结构化数据描述要运行什么:工具名、argv
//       数组、限定在可信根内的 cwd、必填时间预算、env 白名单、显式网络开关(默认关)。
//       workspace 默认只读;只有可信调用方在 limits 中授予能力后,请求才能显式开启写入。
//       配合 spawn 层 shell:false,argv 无法注入 shell 语法,故校验聚焦工具名与资源上限。
// 导出:normalizeSandboxSpec(校验+补默认) / SANDBOX_DEFAULTS(默认值常量)。

const MAX_ARGS = 64;
const MAX_ARG_LENGTH = 8192;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
const TOOL_RE = /^[a-zA-Z0-9_.-]{1,64}$/;
const NUL = String.fromCharCode(0);

export type HttpError = Error & { statusCode?: number };
export type SandboxLimits = {
  allowTools?: readonly string[] | null;
  allowEnv?: readonly string[];
  allowWorkspaceWrite?: boolean;
  allowUnrestrictedHostExecution?: boolean;
  maxTimeoutMs?: number;
  defaultMaxOutputBytes?: number;
};
export type RawSandboxSpec = {
  tool?: unknown;
  args?: unknown;
  cwd?: unknown;
  timeoutMs?: unknown;
  network?: unknown;
  workspaceWrite?: unknown;
  unrestrictedHostExecution?: unknown;
  env?: unknown;
};
export type SandboxSpec = {
  tool: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  network: boolean;
  workspaceWrite: boolean;
  unrestrictedHostExecution: boolean;
  env: Record<string, string>;
  maxOutputBytes: number;
  /** Internal trusted runtime path. Never accepted from a raw sandbox request. */
  executablePath?: string;
};

function fail(message: string): HttpError {
  const error = new Error(`sandbox spec: ${message}`) as HttpError;
  error.statusCode = 400;
  return error;
}

function cleanArg(value: unknown, index: number): string {
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

function cleanEnv(env: unknown, allowEnv?: readonly string[]): Record<string, string> {
  if (env == null) {
    return {};
  }
  if (typeof env !== 'object' || Array.isArray(env)) {
    throw fail('env must be an object');
  }
  const allow = new Set(allowEnv || []);
  const out: Record<string, string> = {};
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

/** 校验并归一化原始 spec 为安全、补齐默认值的执行规格(工具白名单、参数上限、超时夹取、env 白名单)。 */
export function normalizeSandboxSpec(input: RawSandboxSpec, limits: SandboxLimits = {}): SandboxSpec {
  const spec = input || {};
  const allowTools = limits.allowTools || null; // null 表示允许任意符合 TOOL_RE 的裸命令名。
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

  const network = spec.network === true; // 默认关网。
  if (spec.workspaceWrite != null && typeof spec.workspaceWrite !== 'boolean') {
    throw fail('workspaceWrite must be a boolean');
  }
  const workspaceWrite = spec.workspaceWrite === true;
  if (workspaceWrite && limits.allowWorkspaceWrite !== true) {
    throw fail('workspaceWrite requires an explicit capability');
  }
  if (spec.unrestrictedHostExecution != null && typeof spec.unrestrictedHostExecution !== 'boolean') {
    throw fail('unrestrictedHostExecution must be a boolean');
  }
  const unrestrictedHostExecution = spec.unrestrictedHostExecution === true;
  if (unrestrictedHostExecution && limits.allowUnrestrictedHostExecution !== true) {
    throw fail('unrestrictedHostExecution requires an explicit capability');
  }
  const env = cleanEnv(spec.env, limits.allowEnv);

  return {
    tool,
    args,
    cwd,
    timeoutMs,
    network,
    workspaceWrite,
    unrestrictedHostExecution,
    env,
    maxOutputBytes,
  };
}

export const SANDBOX_DEFAULTS = Object.freeze({
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
});
