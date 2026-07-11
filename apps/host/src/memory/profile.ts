// 用户画像(术语/项目/偏好)的存取与召回(host · L1 领域层 · memory)
// ---------------------------------------------------------------------------
// 职责:把用户长期画像以 JSON 形式存进一条记忆笔记(profile.md),提供
//       学习(增量去重)、召回(按查询打分排序)、遗忘(按类型/键过滤)等能力,
//       供上层在对话中读取偏好/术语/当前项目。底层读写委托给注入的 memoryStore。
// 依赖:注入的 MemoryStoreLike(读写记忆笔记);仅标准库,无直接 IO。
// 导出:UserProfile 类、createUserProfile 工厂。

const PROFILE_NOTE = 'profile.md';
const ALLOWED_TYPES = new Set<ProfileType>(['term', 'project', 'preference']);
const MAX_PROFILE_ENTRIES = 200;

export type ProfileType = 'term' | 'project' | 'preference';
export type NowValue = number | string | Date;
export type NowProvider = () => NowValue;
export type ProfileEntry = {
  type: ProfileType;
  key: string;
  value: string;
  evidence: string;
  scope: string;
  updatedAt: string;
};
export type UserProfileData = { version: 1; entries: ProfileEntry[] };
export type ProfileEntryInput = {
  type?: unknown;
  key?: unknown;
  value?: unknown;
  evidence?: unknown;
  scope?: unknown;
};
export type ProfileBulkInput = { entries?: unknown };
export type ProfileRecallOptions = { query?: unknown; limit?: number; context?: Record<string, unknown> };
export type ProfileForgetFilter = { type?: unknown; key?: unknown };
export type MemoryStoreLike = {
  readMemoryNote(
    trustedRoot: string,
    noteName: string,
    context?: Record<string, unknown>,
  ): string | null | Promise<string | null>;
  writeMemoryNote(
    trustedRoot: string,
    noteName: string,
    body: string,
    context?: Record<string, unknown>,
  ): unknown | Promise<unknown>;
};
export type UserProfileOptions = { memoryStore?: MemoryStoreLike; now?: NowProvider };

function emptyProfile(): UserProfileData {
  return { version: 1, entries: [] };
}

function nowIso(now?: NowProvider): string {
  const value = typeof now === 'function' ? now() : Date.now();
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function cleanText(value: unknown, name: string): string {
  const text = String(value == null ? '' : value).trim();
  if (!text) throw new Error(`profile ${name} is required`);
  return text.slice(0, 500);
}

function normalizeType(value: unknown): ProfileType {
  const type = String(value || 'term').trim().toLowerCase() as ProfileType;
  return ALLOWED_TYPES.has(type) ? type : 'term';
}

function normalizeEntry(entry: ProfileEntryInput | null | undefined, now?: NowProvider): ProfileEntry {
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

function isStoredEntry(value: unknown): value is ProfileEntry {
  const entry = value && typeof value === 'object' ? value as Partial<ProfileEntry> : null;
  return Boolean(entry
    && ALLOWED_TYPES.has(entry.type as ProfileType)
    && typeof entry.key === 'string' && entry.key.trim()
    && typeof entry.value === 'string' && entry.value.trim()
    && typeof entry.evidence === 'string' && entry.evidence.trim()
    && typeof entry.scope === 'string' && entry.scope.trim()
    && typeof entry.updatedAt === 'string' && entry.updatedAt.trim());
}

function parseProfile(body: unknown): UserProfileData {
  if (!body || !String(body).trim()) return emptyProfile();
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(body));
  } catch {
    throw new Error('profile note is corrupt or conflicting');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('profile note is corrupt or conflicting');
  }
  const stored = parsed as { version?: unknown; entries?: unknown };
  if (stored.version !== 1 || !Array.isArray(stored.entries) || !stored.entries.every(isStoredEntry)) {
    throw new Error('profile note is corrupt or conflicting');
  }
  const entries = stored.entries as ProfileEntry[];
  const ids = new Set(entries.map(entryId));
  if (ids.size !== entries.length) throw new Error('profile note is corrupt or conflicting');
  return { version: 1, entries };
}

function entryId(entry: ProfileEntry): string {
  return `${entry.type}:${entry.scope}:${entry.key}`.toLowerCase();
}

/** 按查询给条目打分(命中正文最高、其次键被查询包含),无查询时项目类优先,用于召回排序。 */
function scoreEntry(entry: ProfileEntry, query: unknown): number {
  const q = String(query || '').toLowerCase();
  if (!q) return entry.type === 'project' ? 3 : 1;
  const haystack = `${entry.key} ${entry.value} ${entry.evidence}`.toLowerCase();
  if (haystack.includes(q)) return 6;
  if (q.includes(String(entry.key).toLowerCase())) return 5;
  return entry.type === 'preference' ? 2 : 1;
}

function termText(entry: ProfileEntry): string {
  return entry.key === entry.value ? entry.key : `${entry.key} = ${entry.value}`;
}

/** 用户画像门面:以注入的 memoryStore 为后端,封装画像的加载/保存/学习/召回/遗忘。 */
export class UserProfile {
  readonly memoryStore: MemoryStoreLike;
  readonly now: NowProvider;

  constructor({ memoryStore, now = Date.now }: UserProfileOptions = {}) {
    if (!memoryStore) throw new Error('memoryStore is required');
    this.memoryStore = memoryStore;
    this.now = now;
  }

  /** 读取并解析画像笔记;仅不存在/空内容返回空画像,非空损坏或冲突内容显式失败。 */
  async load(trustedRoot: string, context: Record<string, unknown> = {}): Promise<UserProfileData> {
    const body = await this.memoryStore.readMemoryNote(trustedRoot, PROFILE_NOTE, context);
    return parseProfile(body);
  }

  /** 把画像序列化写回笔记(尾部截断到 MAX_PROFILE_ENTRIES 条以限制体积)。 */
  async save(
    trustedRoot: string,
    profile: { entries?: ProfileEntry[] },
    context: Record<string, unknown> = {},
  ): Promise<UserProfileData> {
    const entries = (profile.entries || []).slice(-MAX_PROFILE_ENTRIES);
    const next: UserProfileData = { version: 1, entries };
    await this.memoryStore.writeMemoryNote(trustedRoot, PROFILE_NOTE, JSON.stringify(next, null, 2), context);
    return next;
  }

  /** 学习单条或批量条目:按 entryId(类型:作用域:键)去重合并到现有画像后保存。 */
  async learn(
    trustedRoot: string,
    input: ProfileEntryInput | ProfileBulkInput,
    context: Record<string, unknown> = {},
  ): Promise<UserProfileData> {
    const profile = await this.load(trustedRoot, context);
    const bulk = input || {} as ProfileBulkInput;
    const incoming = Array.isArray((bulk as ProfileBulkInput).entries) ? (bulk as ProfileBulkInput).entries as unknown[] : [input];
    const map = new Map(profile.entries.map((entry) => [entryId(entry), entry]));
    for (const raw of incoming) {
      const entry = normalizeEntry(raw as ProfileEntryInput, this.now);
      map.set(entryId(entry), { ...map.get(entryId(entry)), ...entry });
    }
    return this.save(trustedRoot, { entries: Array.from(map.values()) }, context);
  }

  /** 召回画像:按查询打分排序取前 limit 条(夹在 [1,20]),并析出当前项目与术语列表。 */
  async recall(
    trustedRoot: string,
    { query = '', limit = 8, context = {} }: ProfileRecallOptions = {},
  ): Promise<{ project: string; terms: string[]; entries: ProfileEntry[] }> {
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

  /** 遗忘条目:按 type 和/或 key 过滤删除(两者皆空则抛错以防误清空),返回删除数与新画像。 */
  async forget(
    trustedRoot: string,
    filter: ProfileForgetFilter = {},
    context: Record<string, unknown> = {},
  ): Promise<{ removed: number; profile: UserProfileData }> {
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

export function createUserProfile(options: UserProfileOptions = {}): UserProfile {
  return new UserProfile(options);
}
