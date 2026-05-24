import fs from 'node:fs';
import path from 'node:path';

export function applyPersistedKimiConfig(file, target) {
  try {
    if (!fs.existsSync(file)) return;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const kimi = raw && typeof raw === 'object' ? (raw.kimiApi || raw.kimi || raw) : null;
    if (!kimi || typeof kimi !== 'object') return;
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
    },
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
}
