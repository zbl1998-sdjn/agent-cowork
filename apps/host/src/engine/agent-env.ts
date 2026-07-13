// 运行环境事实解析:为系统提示词的 <env> 块提供日期/工作目录/OS/版本/模型(host · L1 领域层)
// ---------------------------------------------------------------------------
// 职责:把"环境事实"(今天日期、工作目录、操作系统名、应用版本、当前 provider/model)
//       从环境/进程中解析出来,供 system-prompt.js 纯打印使用;本模块负责(同样纯但
//       输入来自环境的)解析,让 system-prompt.js 保持无 I/O。
// 依赖:仅标准库(读 process.platform / process.env / globalThis)。
// 导出:labelOs(OS 名映射)、resolveAppVersion(应用版本兜底解析)、
//       resolveAgentEnvFacts(打包全部环境事实)。
import type { EnvFacts } from './system-prompt.js';

const PLATFORM_LABELS: Record<string, string> = {
  win32: 'Windows',
  darwin: 'macOS',
  linux: 'Linux',
};

type AgentEnvFacts = Required<EnvFacts>;
type AgentEnvOptions = {
  trustedRoot?: unknown;
  kimiConfig?: unknown;
  now?: Date;
  platform?: string;
  appVersion?: string;
};

/**
 * 把 Node 的 process.platform 标识映射成人类可读的操作系统名;未知平台原样返回。
 */
export function labelOs(platform: string): string {
  if (!platform) return '';
  return PLATFORM_LABELS[platform] || platform;
}

/**
 * 尽力解析 host 应用版本号:npm 环境变量 → SEA 内置全局常量 → 兜底 'dev'。
 */
export function resolveAppVersion(): string {
  const fromEnv = typeof process !== 'undefined' && process.env && process.env.npm_package_version;
  if (fromEnv && String(fromEnv).trim()) return String(fromEnv).trim();
  const fromGlobal = typeof globalThis !== 'undefined'
    ? (globalThis as { AGENT_COWORK_VERSION?: unknown }).AGENT_COWORK_VERSION
    : undefined;
  if (typeof fromGlobal === 'string' && fromGlobal.trim()) return fromGlobal.trim();
  return 'dev';
}

/**
 * 把系统提示词所需的运行环境事实打包成一个对象;给定输入即纯函数,测试可逐项覆盖。
 * `kimiConfig` 以 unknown 接入,因为 Agent 循环会传入更窄的 ModelConfig;这里只防御式读取 provider/model。
 */
export function resolveAgentEnvFacts({ trustedRoot, kimiConfig, now, platform, appVersion }: AgentEnvOptions = {}): AgentEnvFacts {
  const safeRoot = typeof trustedRoot === 'string' ? trustedRoot : '';
  const cfg = kimiConfig && typeof kimiConfig === 'object' ? kimiConfig as Record<string, unknown> : null;
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
