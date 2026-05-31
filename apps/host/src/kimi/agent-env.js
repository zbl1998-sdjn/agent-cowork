// @ts-check
// 运行环境事实解析:为系统提示词的 <env> 块提供日期/工作目录/OS/版本/模型(host · L1 领域层)
// ---------------------------------------------------------------------------
// 职责:把"环境事实"(今天日期、工作目录、操作系统名、应用版本、当前 provider/model)
//       从环境/进程中解析出来,供 system-prompt.js 纯打印使用;本模块负责(同样纯但
//       输入来自环境的)解析,让 system-prompt.js 保持无 I/O。
// 依赖:仅标准库(读 process.platform / process.env / globalThis)。
// 导出:labelOs(OS 名映射)、resolveAppVersion(应用版本兜底解析)、
//       resolveAgentEnvFacts(打包全部环境事实)。
// Single source of truth for the "env facts" that buildSystemPrompt's <env>
// block needs: today's date, working directory, OS label, app version, the
// current provider/model. Kept outside system-prompt.js so system-prompt.js
// stays a pure pretty-printer with no I/O — this module does the (also pure
// but inputs-from-environment) resolution.

const PLATFORM_LABELS = {
  win32: 'Windows',
  darwin: 'macOS',
  linux: 'Linux',
};

/**
 * Map a Node.js `process.platform` token to a human-friendly OS name.
 * Unknown platforms pass through as-is so the prompt still says something
 * instead of an empty string.
 *
 * 把 Node 的 process.platform 标识映射成人类可读的操作系统名;未知平台原样返回。
 * @param {string} platform
 * @returns {string}
 */
export function labelOs(platform) {
  if (!platform) return '';
  return PLATFORM_LABELS[/** @type {keyof typeof PLATFORM_LABELS} */ (platform)] || platform;
}

/**
 * Best-effort lookup of the host app version. We read it from
 * `process.env.npm_package_version` when running under npm, and otherwise
 * fall back to a build-time constant the SEA wrapper bakes in via
 * `globalThis.AGENT_COWORK_VERSION`. As a last resort we return 'dev' so
 * the prompt always shows something concrete.
 *
 * 尽力解析 host 应用版本号:npm 环境变量 → SEA 内置全局常量 → 兜底 'dev'。
 * @returns {string}
 */
export function resolveAppVersion() {
  const fromEnv = typeof process !== 'undefined' && process.env && process.env.npm_package_version;
  if (fromEnv && String(fromEnv).trim()) return String(fromEnv).trim();
  const fromGlobal = typeof globalThis !== 'undefined' && /** @type {{ AGENT_COWORK_VERSION?: unknown }} */ (globalThis).AGENT_COWORK_VERSION;
  if (typeof fromGlobal === 'string' && fromGlobal.trim()) return fromGlobal.trim();
  return 'dev';
}

/**
 * Bundle the runtime environment facts the agent's system prompt needs. Pure
 * given its inputs + the current process.platform / process.env, so callers
 * can override anything for testing by passing it explicitly.
 *
 * `kimiConfig` is typed as `unknown` because the agent loop passes its own
 * narrower ModelConfig — we just read provider/model defensively.
 *
 * 把系统提示词所需的运行环境事实打包成一个对象;给定输入即纯函数,测试可逐项覆盖。
 * @param {{ trustedRoot?: unknown, kimiConfig?: unknown, now?: Date, platform?: string, appVersion?: string }} [options]
 * @returns {{ now: Date, trustedRoot: string, osName: string, appVersion: string, provider: string, model: string }}
 */
export function resolveAgentEnvFacts({ trustedRoot, kimiConfig, now, platform, appVersion } = {}) {
  const safeRoot = typeof trustedRoot === 'string' ? trustedRoot : '';
  const cfg = /** @type {Record<string, unknown> | null} */ (kimiConfig && typeof kimiConfig === 'object' ? kimiConfig : null);
  const provider = cfg && typeof cfg.provider === 'string' ? cfg.provider : '';
  const model = cfg && typeof cfg.model === 'string' ? cfg.model : '';
  const platformToken = platform || (typeof process !== 'undefined' ? process.platform : '');
  return {
    now: now instanceof Date ? now : new Date(),
    trustedRoot: safeRoot,
    osName: labelOs(platformToken),
    appVersion: typeof appVersion === 'string' && appVersion ? appVersion : resolveAppVersion(),
    provider,
    model,
  };
}
