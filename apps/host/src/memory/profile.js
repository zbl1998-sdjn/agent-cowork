const PROFILE_NOTE = 'profile.md';
const ALLOWED_TYPES = new Set(['term', 'project', 'preference']);
const MAX_PROFILE_ENTRIES = 200;

function emptyProfile() {
  return { version: 1, entries: [] };
}

function nowIso(now) {
  const value = typeof now === 'function' ? now() : Date.now();
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function cleanText(value, name) {
  const text = String(value == null ? '' : value).trim();
  if (!text) throw new Error(`profile ${name} is required`);
  return text.slice(0, 500);
}

function normalizeType(value) {
  const type = String(value || 'term').trim().toLowerCase();
  return ALLOWED_TYPES.has(type) ? type : 'term';
}

function normalizeEntry(entry, now) {
  const type = normalizeType(entry?.type);
  return {
    type,
    key: cleanText(entry?.key, 'key'),
    value: cleanText(entry?.value, 'value'),
    evidence: cleanText(entry?.evidence || 'explicit_user_confirmation', 'evidence'),
    scope: String(entry?.scope || 'user').trim().toLowerCase().slice(0, 40) || 'user',
    updatedAt: nowIso(now),
  };
}

function parseProfile(body) {
  if (!body || !String(body).trim()) return emptyProfile();
  try {
    const parsed = JSON.parse(String(body));
    if (parsed && Array.isArray(parsed.entries)) {
      return { version: 1, entries: parsed.entries.filter((entry) => entry && entry.key && entry.value) };
    }
  } catch {
    // Corrupt profile notes degrade to an empty editable profile.
  }
  return emptyProfile();
}

function entryId(entry) {
  return `${entry.type}:${entry.scope}:${entry.key}`.toLowerCase();
}

function scoreEntry(entry, query) {
  const q = String(query || '').toLowerCase();
  if (!q) return entry.type === 'project' ? 3 : 1;
  const haystack = `${entry.key} ${entry.value} ${entry.evidence}`.toLowerCase();
  if (haystack.includes(q)) return 6;
  if (q.includes(String(entry.key).toLowerCase())) return 5;
  return entry.type === 'preference' ? 2 : 1;
}

function termText(entry) {
  return entry.key === entry.value ? entry.key : `${entry.key} = ${entry.value}`;
}

export class UserProfile {
  constructor({ memoryStore, now = Date.now } = {}) {
    if (!memoryStore) throw new Error('memoryStore is required');
    this.memoryStore = memoryStore;
    this.now = now;
  }

  async load(trustedRoot, context = {}) {
    const body = await this.memoryStore.readMemoryNote(trustedRoot, PROFILE_NOTE, context);
    return parseProfile(body);
  }

  async save(trustedRoot, profile, context = {}) {
    const entries = (profile.entries || []).slice(-MAX_PROFILE_ENTRIES);
    const next = { version: 1, entries };
    await this.memoryStore.writeMemoryNote(trustedRoot, PROFILE_NOTE, JSON.stringify(next, null, 2), context);
    return next;
  }

  async learn(trustedRoot, input, context = {}) {
    const profile = await this.load(trustedRoot, context);
    const incoming = Array.isArray(input?.entries) ? input.entries : [input];
    const map = new Map(profile.entries.map((entry) => [entryId(entry), entry]));
    for (const raw of incoming) {
      const entry = normalizeEntry(raw, this.now);
      map.set(entryId(entry), { ...map.get(entryId(entry)), ...entry });
    }
    return this.save(trustedRoot, { entries: Array.from(map.values()) }, context);
  }

  async recall(trustedRoot, { query = '', limit = 8, context = {} } = {}) {
    const profile = await this.load(trustedRoot, context);
    const entries = profile.entries
      .map((entry) => ({ entry, score: scoreEntry(entry, query) }))
      .sort((a, b) => b.score - a.score || a.entry.key.localeCompare(b.entry.key))
      .slice(0, Math.max(1, Math.min(20, limit)))
      .map((item) => item.entry);
    const project = entries.find((entry) => entry.type === 'project')?.value || '';
    const terms = entries.filter((entry) => entry.type === 'term').map(termText);
    return { project, terms, entries };
  }

  async forget(trustedRoot, filter = {}, context = {}) {
    const type = filter.type ? normalizeType(filter.type) : '';
    const key = String(filter.key || '').trim().toLowerCase();
    if (!type && !key) throw new Error('profile forget requires type or key');
    const profile = await this.load(trustedRoot, context);
    const kept = profile.entries.filter((entry) => {
      const typeMatches = !type || entry.type === type;
      const keyMatches = !key || String(entry.key).toLowerCase() === key;
      return !(typeMatches && keyMatches);
    });
    const next = await this.save(trustedRoot, { entries: kept }, context);
    return { removed: profile.entries.length - kept.length, profile: next };
  }
}

export function createUserProfile(options = {}) {
  return new UserProfile(options);
}
