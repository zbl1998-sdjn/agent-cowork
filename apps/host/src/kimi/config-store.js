// @ts-check
import fs from 'node:fs';
import path from 'node:path';

/** @param {unknown} value */
function cleanProvider(value) {
  return String(value || '').trim().toLowerCase();
}

/** @param {unknown} value @returns {Array<Record<string, unknown>>} */
function cleanFallbacks(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const source = item && typeof item === 'object' ? /** @type {Record<string, unknown>} */ (item) : {};
    const out = /** @type {Record<string, unknown>} */ ({});
    if (typeof source.provider === 'string' && source.provider.trim()) out.provider = cleanProvider(source.provider);
    if (typeof source.apiKey === 'string' && source.apiKey.trim()) out.apiKey = source.apiKey.trim();
    if (typeof source.baseUrl === 'string' && source.baseUrl.trim()) out.baseUrl = source.baseUrl.trim().replace(/\/+$/, '');
    if (typeof source.model === 'string' && source.model.trim()) out.model = source.model.trim();
    if (Number.isFinite(Number(source.timeoutMs))) out.timeoutMs = Math.max(1000, Number(source.timeoutMs));
    if (Number.isFinite(Number(source.maxTokens))) out.maxTokens = Math.max(1, Number(source.maxTokens));
    return out;
  }).filter((item) => item.provider || item.baseUrl || item.model || item.apiKey);
}

/** @param {string} file @param {Record<string, unknown>} target */
export function applyPersistedKimiConfig(file, target) {
  try {
    if (!fs.existsSync(file)) return;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const config = raw && typeof raw === 'object' ? /** @type {Record<string, unknown>} */ (raw) : {};
    const kimi = config.kimiApi || config.kimi || config;
    if (!kimi || typeof kimi !== 'object') return;
    const source = /** @type {Record<string, unknown>} */ (kimi);
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

/** @param {string} file @param {Record<string, unknown>} source */
export function persistKimiConfig(file, source) {
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
