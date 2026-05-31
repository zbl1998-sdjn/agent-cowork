// Kimi/模型 API 的配置常量与解析:默认值、provider 归一、回退链(host · L1 领域层)
// ---------------------------------------------------------------------------
// 职责:集中放置默认 baseUrl/model/超时/maxTokens 等常量,并把 config+env 解析成
//       一份规范化的 KimiApiConfig(含 Anthropic/Kimi 不同的 key/url/model 取值规则)。
// 依赖:仅标准库(读 process.env)。
// 导出:常量(DEFAULT_*、MAX_PROMPT_LENGTH、KIMI_API_NOT_CONFIGURED_MESSAGE)、
//       cleanText、cleanProvider、resolveKimiApiConfig。
import { omitUndefined } from '../util/object.js';

export const DEFAULT_BASE_URL = 'https://api.moonshot.ai/v1';
export const DEFAULT_MODEL = 'kimi-k2.6';
export const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1';
export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_TOKENS = 2048;
export const MAX_PROMPT_LENGTH = 8000;
export const KIMI_API_NOT_CONFIGURED_MESSAGE = '未配置 Kimi/Moonshot API Key。本地文件功能仍可离线使用；需要模型回复时请联网并配置 KIMI_API_KEY 或 MOONSHOT_API_KEY。';

export type ModelFallback = {
  provider?: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  maxTokens?: number;
  temperature?: number;
};
export type KimiApiConfig = {
  provider: string;
  configured: boolean;
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  maxTokens: number;
  temperature?: number;
  userAgent: string;
  fallbacks: ModelFallback[];
};

/** 规范化文本:统一换行、去首尾空白;非字符串安全转空串。 */
export function cleanText(value: unknown): string {
  return String(value || '').replace(/\r\n/g, '\n').trim();
}

/** 归一化 provider 名(小写去空白),空值用 fallback 兜底。 */
export function cleanProvider(value: unknown, fallback = 'kimi-api'): string {
  const provider = String(value || '').trim().toLowerCase();
  return provider || fallback;
}

/** 判断 provider 是否走 Anthropic/Claude 系(决定 key/url/model 的取值来源)。 */
function isAnthropicProvider(provider: string): boolean {
  return provider === 'anthropic' || provider === 'claude';
}

/** 解析模型回退链:接受 JSON 字符串或数组,逐项规范化并丢弃空条目。 */
function cleanModelFallbacks(value: unknown): ModelFallback[] {
  let input = value;
  if (typeof input === 'string' && input.trim()) {
    try { input = JSON.parse(input); } catch { return []; }
  }
  if (!Array.isArray(input)) return [];
  return input.map((item) => {
    const source = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    const fallback: ModelFallback = {};
    const provider = cleanProvider(source.provider || source.kimiProvider || source.modelProvider, '');
    if (provider) fallback.provider = provider;
    if (typeof source.apiKey === 'string' && source.apiKey.trim()) fallback.apiKey = source.apiKey.trim();
    if (typeof source.baseUrl === 'string' && source.baseUrl.trim()) fallback.baseUrl = source.baseUrl.trim().replace(/\/+$/, '');
    if (typeof source.model === 'string' && source.model.trim()) fallback.model = source.model.trim();
    if (Number.isFinite(Number(source.timeoutMs))) fallback.timeoutMs = Math.max(1000, Number(source.timeoutMs));
    if (Number.isFinite(Number(source.maxTokens))) fallback.maxTokens = Math.max(1, Number(source.maxTokens));
    if (Number.isFinite(Number(source.temperature))) fallback.temperature = Number(source.temperature);
    return fallback;
  }).filter((item) => item.provider || item.baseUrl || item.model || item.apiKey);
}

/** 把 config 与环境变量合并解析成规范化的 KimiApiConfig(含 provider/key/url/model/回退链)。 */
export function resolveKimiApiConfig(
  config: Record<string, unknown> = {},
  env: Record<string, string | undefined> = process.env,
): KimiApiConfig {
  const provider = cleanProvider(config.kimiProvider || config.modelProvider || env.KCW_MODEL_PROVIDER || env.KIMI_PROVIDER);
  const fallbackInput = config.kimiFallbacks ?? config.modelFallbacks ?? env.KCW_MODEL_FALLBACKS ?? env.KIMI_MODEL_FALLBACKS;
  const anthropic = isAnthropicProvider(provider);
  const apiKey = String(
    config.kimiApiKey
    || (anthropic ? env.ANTHROPIC_API_KEY || env.CLAUDE_API_KEY : env.KIMI_API_KEY || env.MOONSHOT_API_KEY)
    || '',
  ).trim();
  const baseUrl = String(
    config.kimiBaseUrl
    || (anthropic ? env.ANTHROPIC_BASE_URL || DEFAULT_ANTHROPIC_BASE_URL : env.KIMI_BASE_URL || env.MOONSHOT_BASE_URL || DEFAULT_BASE_URL),
  ).trim();
  const model = String(
    config.kimiModel
    || (anthropic ? env.ANTHROPIC_MODEL || env.CLAUDE_MODEL || '' : env.KIMI_MODEL || DEFAULT_MODEL),
  ).trim();
  const timeoutMs = Math.max(1000, Number(config.kimiApiTimeoutMs || env.KIMI_API_TIMEOUT_MS || DEFAULT_TIMEOUT_MS));
  const maxTokens = Math.max(1, Number(config.kimiApiMaxTokens || env.KIMI_API_MAX_TOKENS || DEFAULT_MAX_TOKENS));
  const userAgent = String(config.kimiUserAgent || env.KIMI_USER_AGENT || '').trim();
  const tempRaw = config.kimiTemperature != null ? config.kimiTemperature : env.KIMI_TEMPERATURE;
  const temperature = tempRaw != null && tempRaw !== '' && Number.isFinite(Number(tempRaw)) ? Number(tempRaw) : undefined;
  return omitUndefined({
    provider,
    configured: Boolean(apiKey),
    apiKey,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    model,
    timeoutMs,
    maxTokens,
    temperature,
    userAgent,
    fallbacks: cleanModelFallbacks(fallbackInput),
  });
}
