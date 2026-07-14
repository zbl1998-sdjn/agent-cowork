// Kimi 配置持久化(host · L1 领域层)
// ---------------------------------------------------------------------------
// 职责:读写磁盘上的 kimiApi 配置(provider/apiKey/baseUrl/model/fallbacks),
//       做字段清洗与归一;仅缺失文件时回退到环境变量派生的配置。
// 安全:apiKey(含 fallbacks 内的)写盘前经 CredentialProtector 封印
//       (Windows=DPAPI / 其余 AES-GCM,与 credential-store 同一模式),磁盘不落明文;
//       读侧兼容三种形态——封印密文(解封)、遗留明文(原样读入,下次写盘自动升级)、
//       解封失败(如换机器/换用户 DPAPI 打不开)按"未配置"跳过该 key,不拖垮其他字段。
// 依赖:node:fs / node:path + L0 security/credential-store。
// 导出:applyPersistedAgentModelConfig(读入并写进目标对象)、persistModelConfig(写盘)。
import { composeFullModelId, normaliseModelProviderId, providerRequiresApiKey } from './provider/catalog.js';
import {
  createDefaultCredentialProtector,
  isSealedCredential,
  type CredentialProtector,
} from '../security/credential-store.js';
import { createManagedSingleFileOperation } from '../security/managed-single-file.js';
import { syncActiveProviderProfile } from './provider-profiles.js';
import type { AgentModelConfig, ProviderProfile } from './api-runner-config.js';

type AgentModelConfigRecord = Record<string, unknown>;
type ConfigStoreOptions = { protector?: CredentialProtector };

// 默认加密器懒加载单例:DPAPI 每次 protect/unprotect 都要拉起 PowerShell,
// 只有真正碰到 apiKey 时才创建/调用,避免无谓的进程开销。
let defaultProtector: CredentialProtector | null = null;
function activeProtector(options: ConfigStoreOptions): CredentialProtector {
  if (options.protector) return options.protector;
  if (!defaultProtector) defaultProtector = createDefaultCredentialProtector();
  return defaultProtector;
}

/** 写侧封印:非空且尚未封印的明文 key 加密;空串原样(不 protect 空值)。 */
function sealSecret(value: string, protector: CredentialProtector): string {
  if (!value || isSealedCredential(value)) return value;
  return protector.protect(value);
}

/** 读侧解封:封印密文尝试解开,失败返回 null(按未配置处理);明文遗留原样返回。 */
function unsealSecret(value: string, protector: CredentialProtector): string | null {
  if (!isSealedCredential(value)) return value;
  try {
    return protector.unprotect(value);
  } catch {
    return null;
  }
}

/** 把 provider 归一为去空白的小写串。 */
function cleanProvider(value: unknown): string {
  return normaliseModelProviderId(value, '');
}

function recomputeConfigured(target: AgentModelConfigRecord): void {
  const provider = cleanProvider(target.provider) || 'kimi-api';
  const baseUrl = String(target.baseUrl || '').trim();
  const model = String(target.model || '').trim();
  const apiKey = String(target.apiKey || '').trim();
  target.provider = provider;
  target.fullModelId = composeFullModelId(provider, model);
  target.configured = providerRequiresApiKey(provider) ? Boolean(apiKey) : Boolean(baseUrl && model);
}

/** 清洗 fallback 列表:仅保留有效字段,丢弃完全为空的项。 */
function cleanFallbacks(value: unknown): AgentModelConfigRecord[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const source = item && typeof item === 'object' ? item as AgentModelConfigRecord : {};
    const out: AgentModelConfigRecord = {};
    if (typeof source.provider === 'string' && source.provider.trim()) out.provider = cleanProvider(source.provider);
    if (typeof source.apiKey === 'string' && source.apiKey.trim()) out.apiKey = source.apiKey.trim();
    if (typeof source.baseUrl === 'string' && source.baseUrl.trim()) out.baseUrl = source.baseUrl.trim().replace(/\/+$/, '');
    if (typeof source.model === 'string' && source.model.trim()) out.model = source.model.trim();
    if (Number.isFinite(Number(source.timeoutMs))) out.timeoutMs = Math.max(1000, Number(source.timeoutMs));
    if (Number.isFinite(Number(source.maxTokens))) out.maxTokens = Math.max(1, Number(source.maxTokens));
    return out;
  }).filter((item) => item.provider || item.baseUrl || item.model || item.apiKey);
}

function cleanProfile(value: unknown): ProviderProfile {
  const source = value && typeof value === 'object' ? value as AgentModelConfigRecord : {};
  const profile: ProviderProfile = {};
  if (typeof source.apiKey === 'string' && source.apiKey.trim()) profile.apiKey = source.apiKey.trim();
  if (typeof source.baseUrl === 'string' && source.baseUrl.trim()) profile.baseUrl = source.baseUrl.trim().replace(/\/+$/, '');
  if (typeof source.model === 'string' && source.model.trim()) profile.model = source.model.trim();
  if (Number.isFinite(Number(source.timeoutMs))) profile.timeoutMs = Math.max(1000, Number(source.timeoutMs));
  if (Number.isFinite(Number(source.maxTokens))) profile.maxTokens = Math.max(1, Number(source.maxTokens));
  if (Number.isFinite(Number(source.temperature))) profile.temperature = Number(source.temperature);
  return profile;
}

function unsealProfiles(
  value: unknown,
  options: ConfigStoreOptions,
): Record<string, ProviderProfile> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const profiles: Record<string, ProviderProfile> = {};
  for (const [rawProvider, rawProfile] of Object.entries(value as AgentModelConfigRecord)) {
    const provider = cleanProvider(rawProvider);
    if (!provider) continue;
    const profile = cleanProfile(rawProfile);
    if (profile.apiKey) {
      const plain = unsealSecret(profile.apiKey, activeProtector(options));
      if (plain) profile.apiKey = plain;
      else delete profile.apiKey;
    }
    profiles[provider] = profile;
  }
  return profiles;
}

function sealProfiles(
  value: unknown,
  options: ConfigStoreOptions,
): Record<string, ProviderProfile> {
  const profiles = unsealProfiles(value, { protector: { protect: String, unprotect: String } });
  return Object.fromEntries(Object.entries(profiles).map(([provider, profile]) => [
    provider,
    profile.apiKey
      ? { ...profile, apiKey: sealSecret(profile.apiKey, activeProtector(options)) }
      : profile,
  ]));
}

/** 读取持久化配置文件并把清洗后的字段写进 target(原地修改);仅文件不存在时不动。 */
export function applyPersistedAgentModelConfig(file: string, target: AgentModelConfigRecord, options: ConfigStoreOptions = {}): void {
  let serialized: string;
  try {
    const persisted = createManagedSingleFileOperation(file, 'Kimi config directory').readText();
    if (persisted === null) return;
    serialized = persisted;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read Kimi config file: ${file}: ${detail}`, { cause: error });
  }

  let raw: unknown;
  try {
    raw = JSON.parse(serialized);
  } catch (error) {
    throw new Error(`Failed to parse Kimi config file: ${file}`, { cause: error });
  }
  const config = raw && typeof raw === 'object' ? raw as AgentModelConfigRecord : {};
  const kimi = config.kimiApi || config.kimi || config;
  if (!kimi || typeof kimi !== 'object') return;
  const source = kimi as AgentModelConfigRecord;
  const targetProfiles = target.providerProfiles && typeof target.providerProfiles === 'object'
    ? target.providerProfiles as Record<string, ProviderProfile>
    : {};
  target.providerProfiles = { ...targetProfiles, ...unsealProfiles(source.providerProfiles, options) };
  if (typeof source.provider === 'string' && source.provider.trim()) target.provider = cleanProvider(source.provider);
  if (Array.isArray(source.fallbacks)) {
    // fallback 内的 apiKey 同样解封;解不开的按未配置丢弃该 key,保留其余路由字段。
    target.fallbacks = cleanFallbacks(source.fallbacks).map((item) => {
      if (typeof item.apiKey !== 'string' || !item.apiKey) return item;
      const plain = unsealSecret(item.apiKey, activeProtector(options));
      if (plain) return { ...item, apiKey: plain };
      const { apiKey: _dropped, ...rest } = item;
      return rest;
    }).filter((item) => item.provider || item.baseUrl || item.model || item.apiKey);
  }
  if (typeof source.apiKey === 'string' && source.apiKey.trim()) {
    const plain = unsealSecret(source.apiKey.trim(), activeProtector(options));
    if (plain) target.apiKey = plain;
  }
  if (typeof source.baseUrl === 'string' && source.baseUrl.trim()) {
    target.baseUrl = source.baseUrl.trim().replace(/\/+$/, '');
  }
  if (typeof source.model === 'string' && source.model.trim()) target.model = source.model.trim();
  recomputeConfigured(target);
  syncActiveProviderProfile(target as AgentModelConfig);
}

/** 把 source 中的 kimiApi 字段序列化写入磁盘(自动创建父目录);apiKey 一律封印后落盘。 */
export function persistModelConfig(file: string, source: AgentModelConfigRecord, options: ConfigStoreOptions = {}): void {
  syncActiveProviderProfile(source as AgentModelConfig);
  const apiKey = String(source.apiKey || '').trim();
  const payload = {
    kimiApi: {
      apiKey: apiKey ? sealSecret(apiKey, activeProtector(options)) : '',
      baseUrl: source.baseUrl || '',
      model: source.model || '',
      provider: source.provider || 'kimi-api',
      providerProfiles: sealProfiles(source.providerProfiles, options),
      fallbacks: cleanFallbacks(source.fallbacks).map((item) => (
        typeof item.apiKey === 'string' && item.apiKey
          ? { ...item, apiKey: sealSecret(item.apiKey, activeProtector(options)) }
          : item
      )),
    },
  };
  const serialized = JSON.stringify(payload, null, 2);
  createManagedSingleFileOperation(file, 'Kimi config directory').writeText(serialized);
}
