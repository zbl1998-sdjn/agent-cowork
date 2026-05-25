import fs from 'node:fs';
import path from 'node:path';

function cleanProvider(value) {
  return String(value || '').trim().toLowerCase();
}

function cleanFallbacks(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const source = item && typeof item === 'object' ? item : {};
    const out = {};
    if (typeof source.provider === 'string' && source.provider.trim()) out.provider = cleanProvider(source.provider);
    if (typeof source.apiKey === 'string' && source.apiKey.trim()) out.apiKey = source.apiKey.trim();
    if (typeof source.baseUrl === 'string' && source.baseUrl.trim()) out.baseUrl = source.baseUrl.trim().replace(/\/+$/, '');
    if (typeof source.model === 'string' && source.model.trim()) out.model = source.model.trim();
    if (Number.isFinite(Number(source.timeoutMs))) out.timeoutMs = Math.max(1000, Number(source.timeoutMs));
    if (Number.isFinite(Number(source.maxTokens))) out.maxTokens = Math.max(1, Number(source.maxTokens));
    return out;
  }).filter((item) => item.provider || item.baseUrl || item.model || item.apiKey);
}

export function applyPersistedKimiConfig(file, target) {
  try {
    if (!fs.existsSync(file)) return;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const kimi = raw && typeof raw === 'object' ? (raw.kimiApi || raw.kimi || raw) : null;
    if (!kimi || typeof kimi !== 'object') return;
    if (typeof kimi.provider === 'string' && kimi.provider.trim()) target.provider = cleanProvider(kimi.provider);
    if (Array.isArray(kimi.fallbacks)) target.fallbacks = cleanFallbacks(kimi.fallbacks);
    if (typeof kimi.apiKey === 'string' && kimi.apiKey.trim()) target.apiKey = kimi.apiKey.trim();
    if (typeof kimi.baseUrl === 'string' && kimi.baseUrl.trim()) {
      target.baseUrl = kimi.baseUrl.trim().replace(/\/+$/, '');
    }
    if (typeof kimi.model === 'string' && kimi.model.trim()) target.model = kimi.model.trim();
    target.configured = Boolean(target.apiKey);
  } catch {
    // Corrupt config file -> ignore and fall back to env-derived config.
  }
}

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
