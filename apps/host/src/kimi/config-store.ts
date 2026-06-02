// Kimi 配置持久化(host · L1 领域层)
// ---------------------------------------------------------------------------
// 职责:读写磁盘上的 kimiApi 配置(provider/apiKey/baseUrl/model/fallbacks),
//       做字段清洗与归一,损坏文件时静默回退到环境变量派生的配置。
// 依赖:node:fs / node:path(均标准库)。
// 导出:applyPersistedKimiConfig(读入并写进目标对象)、persistKimiConfig(写盘)。
import fs from 'node:fs';
import path from 'node:path';

type KimiConfigRecord = Record<string, unknown>;

/** 把 provider 归一为去空白的小写串。 */
function cleanProvider(value: unknown): string {
  return String(value || '').trim().toLowerCase();
}

/** 清洗 fallback 列表:仅保留有效字段,丢弃完全为空的项。 */
function cleanFallbacks(value: unknown): KimiConfigRecord[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const source = item && typeof item === 'object' ? item as KimiConfigRecord : {};
    const out: KimiConfigRecord = {};
    if (typeof source.provider === 'string' && source.provider.trim()) out.provider = cleanProvider(source.provider);
    if (typeof source.apiKey === 'string' && source.apiKey.trim()) out.apiKey = source.apiKey.trim();
    if (typeof source.baseUrl === 'string' && source.baseUrl.trim()) out.baseUrl = source.baseUrl.trim().replace(/\/+$/, '');
    if (typeof source.model === 'string' && source.model.trim()) out.model = source.model.trim();
    if (Number.isFinite(Number(source.timeoutMs))) out.timeoutMs = Math.max(1000, Number(source.timeoutMs));
    if (Number.isFinite(Number(source.maxTokens))) out.maxTokens = Math.max(1, Number(source.maxTokens));
    return out;
  }).filter((item) => item.provider || item.baseUrl || item.model || item.apiKey);
}

/** 读取持久化配置文件并把清洗后的字段写进 target(原地修改);文件不存在或损坏则不动。 */
export function applyPersistedKimiConfig(file: string, target: KimiConfigRecord): void {
  try {
    if (!fs.existsSync(file)) return;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const config = raw && typeof raw === 'object' ? raw as KimiConfigRecord : {};
    const kimi = config.kimiApi || config.kimi || config;
    if (!kimi || typeof kimi !== 'object') return;
    const source = kimi as KimiConfigRecord;
    if (typeof source.provider === 'string' && source.provider.trim()) target.provider = cleanProvider(source.provider);
    if (Array.isArray(source.fallbacks)) target.fallbacks = cleanFallbacks(source.fallbacks);
    if (typeof source.apiKey === 'string' && source.apiKey.trim()) target.apiKey = source.apiKey.trim();
    if (typeof source.baseUrl === 'string' && source.baseUrl.trim()) {
      target.baseUrl = source.baseUrl.trim().replace(/\/+$/, '');
    }
    if (typeof source.model === 'string' && source.model.trim()) target.model = source.model.trim();
    target.configured = Boolean(target.apiKey);
  } catch {
    // Corrupt config file -> ignore and fall back to env-derived config.
  }
}

/** 把 source 中的 kimiApi 字段序列化写入磁盘(自动创建父目录)。 */
export function persistKimiConfig(file: string, source: KimiConfigRecord): void {
  const payload = {
    kimiApi: {
      apiKey: source.apiKey || '',
      baseUrl: source.baseUrl || '',
      model: source.model || '',
      provider: source.provider || 'kimi-api',
      fallbacks: cleanFallbacks(source.fallbacks),
    },
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
}
