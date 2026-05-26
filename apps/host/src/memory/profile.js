const PROFILE_NOTE = 'profile.md';
const ALLOWED_TYPES = new Set(['term', 'project', 'preference']);
const MAX_PROFILE_ENTRIES = 200;

/**
 * @typedef {'term' | 'project' | 'preference'} ProfileType
 * @typedef {number | string | Date} NowValue
 * @typedef {() => NowValue} NowProvider
 * @typedef {{ type: ProfileType, key: string, value: string, evidence: string, scope: string, updatedAt: string }} ProfileEntry
 * @typedef {{ version: 1, entries: ProfileEntry[] }} UserProfileData
 * @typedef {{ type?: unknown, key?: unknown, value?: unknown, evidence?: unknown, scope?: unknown }} ProfileEntryInput
 * @typedef {{ entries?: unknown }} ProfileBulkInput
 * @typedef {{ query?: unknown, limit?: number, context?: Record<string, unknown> }} ProfileRecallOptions
 * @typedef {{ type?: unknown, key?: unknown }} ProfileForgetFilter
 * @typedef {{ readMemoryNote(trustedRoot: string, noteName: string, context?: Record<string, unknown>): string | null | Promise<string | null>, writeMemoryNote(trustedRoot: string, noteName: string, body: string, context?: Record<string, unknown>): unknown | Promise<unknown> }} MemoryStoreLike
 * @typedef {{ memoryStore?: MemoryStoreLike, now?: NowProvider }} UserProfileOptions
 */

/** @returns {UserProfileData} */
function emptyProfile() {
  return { version: 1, entries: [] };
}

/** @param {NowProvider | undefined} now @returns {string} */
function nowIso(now) {
  const value = typeof now === 'function' ? now() : Date.now();
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** @param {unknown} value @param {string} name @returns {string} */
function cleanText(value, name) {
  const text = String(value == null ? '' : value).trim();
  if (!text) throw new Error(`profile ${name} is required`);
  return text.slice(0, 500);
}

/** @param {unknown} value @returns {ProfileType} */
function normalizeType(value) {
  const type = String(value || 'term').trim().toLowerCase();
  return ALLOWED_TYPES.has(type) ? /** @type {ProfileType} */ (type) : 'term';
}

/** @param {ProfileEntryInput | null | undefined} entry @param {NowProvider | undefined} now @returns {ProfileEntry} */
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

/** @param {unknown} value @returns {value is ProfileEntry} */
function isStoredEntry(value) {
  const entry = /** @type {Partial<ProfileEntry> | null} */ (
    value && typeof value === 'object' ? value : null
  );
  return Boolean(entry?.key && entry?.value);
}

/** @param {unknown} body @returns {UserProfileData} */
function parseProfile(body) {
  if (!body || !String(body).trim()) return emptyProfile();
  try {
    const parsed = /** @type {{ entries?: unknown }} */ (JSON.parse(String(body)));
    if (parsed && Array.isArray(parsed.entries)) {
      return { version: 1, entries: parsed.entries.filter(isStoredEntry) };
    }
  } catch {
    // Corrupt profile notes degrade to an empty editable profile.
  }
  return emptyProfile();
}

/** @param {ProfileEntry} entry @returns {string} */
function entryId(entry) {
  return `${entry.type}:${entry.scope}:${entry.key}`.toLowerCase();
}

/** @param {ProfileEntry} entry @param {unknown} query @returns {number} */
function scoreEntry(entry, query) {
  const q = String(query || '').toLowerCase();
  if (!q) return entry.type === 'project' ? 3 : 1;
  const haystack = `${entry.key} ${entry.value} ${entry.evidence}`.toLowerCase();
  if (haystack.includes(q)) return 6;
  if (q.includes(String(entry.key).toLowerCase())) return 5;
  return entry.type === 'preference' ? 2 : 1;
}

/** @param {ProfileEntry} entry @returns {string} */
function termText(entry) {
  return entry.key === entry.value ? entry.key : `${entry.key} = ${entry.value}`;
}

export class UserProfile {
  /** @type {MemoryStoreLike} */
  memoryStore;

  /** @type {NowProvider} */
  now;

  /** @param {UserProfileOptions} [options] */
  constructor({ memoryStore, now = Date.now } = {}) {
    if (!memoryStore) throw new Error('memoryStore is required');
    this.memoryStore = memoryStore;
    this.now = now;
  }

  /** @param {string} trustedRoot @param {Record<string, unknown>} [context] @returns {Promise<UserProfileData>} */
  async load(trustedRoot, context = {}) {
    const body = await this.memoryStore.readMemoryNote(trustedRoot, PROFILE_NOTE, context);
    return parseProfile(body);
  }

  /** @param {string} trustedRoot @param {{ entries?: ProfileEntry[] }} profile @param {Record<string, unknown>} [context] @returns {Promise<UserProfileData>} */
  async save(trustedRoot, profile, context = {}) {
    const entries = (profile.entries || []).slice(-MAX_PROFILE_ENTRIES);
    /** @type {UserProfileData} */
    const next = { version: 1, entries };
    await this.memoryStore.writeMemoryNote(trustedRoot, PROFILE_NOTE, JSON.stringify(next, null, 2), context);
    return next;
  }

  /** @param {string} trustedRoot @param {ProfileEntryInput | ProfileBulkInput} input @param {Record<string, unknown>} [context] @returns {Promise<UserProfileData>} */
  async learn(trustedRoot, input, context = {}) {
    const profile = await this.load(trustedRoot, context);
    const bulk = /** @type {ProfileBulkInput} */ (input || {});
    const incoming = Array.isArray(bulk.entries) ? bulk.entries : [input];
    const map = new Map(profile.entries.map((entry) => [entryId(entry), entry]));
    for (const raw of incoming) {
      const entry = normalizeEntry(/** @type {ProfileEntryInput} */ (raw), this.now);
      map.set(entryId(entry), { ...map.get(entryId(entry)), ...entry });
    }
    return this.save(trustedRoot, { entries: Array.from(map.values()) }, context);
  }

  /** @param {string} trustedRoot @param {ProfileRecallOptions} [options] @returns {Promise<{ project: string, terms: string[], entries: ProfileEntry[] }>} */
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

  /** @param {string} trustedRoot @param {ProfileForgetFilter} [filter] @param {Record<string, unknown>} [context] @returns {Promise<{ removed: number, profile: UserProfileData }>} */
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

/** @param {UserProfileOptions} [options] @returns {UserProfile} */
export function createUserProfile(options = {}) {
  return new UserProfile(options);
}
