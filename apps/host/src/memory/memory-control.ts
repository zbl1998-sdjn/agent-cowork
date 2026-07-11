// MemoryCore 控制面(host · L1 领域层 · memory)
// ---------------------------------------------------------------------------
// 职责:在既有 file/sqlite memory store 之上提供 2.1 所需的 settings/snapshot/items
//       语义:暂停/隐身、候选安全判定、用户可见条目 DTO 与跨窗口召回快照。
import { createUserProfile, type MemoryStoreLike, type ProfileEntry, type ProfileType } from './profile.js';
import { decideMemoryDlp } from './memory-dlp-guard.js';
import { isMemoryActive, readMemorySettings, type MemorySettings } from './memory-settings.js';
export {
  isMemoryActive,
  isMemoryActiveForRoot,
  readMemorySettings,
  writeMemorySettings,
  type MemorySettings,
} from './memory-settings.js';

export type MemoryItem = {
  id: string;
  scope: string;
  kind: ProfileType;
  title: string;
  content: string;
  evidence: string;
  enabled: boolean;
  updatedAt?: string;
};

export type MemoryPolicyDecision = {
  action: 'allow_auto_write' | 'deny_write';
  sensitivity: 'normal' | 'secret';
  reason: string;
};

export type MemorySnapshot = {
  settings: MemorySettings;
  userPreferences: MemoryItem[];
  projectSummary: string;
  workspaceSummary: string;
  recentProgress: MemoryItem[];
  correctionRules: MemoryItem[];
  artifactHints: MemoryItem[];
  capabilityState: MemoryItem[];
  used: MemoryItem[];
  omitted: Array<{ reason: string; count: number }>;
};

export type MemoryItemInput = {
  kind?: unknown;
  title?: unknown;
  content?: unknown;
  evidence?: unknown;
  scope?: unknown;
};

function nowIso(now: Date = new Date()): string {
  return now.toISOString();
}

function normalizeScope(value: unknown, fallback: MemorySettings['defaultScope'] = 'project'): MemorySettings['defaultScope'] {
  const text = String(value || '').trim().toLowerCase();
  return text === 'user' || text === 'session' || text === 'project' ? text : fallback;
}

function normalizeKind(value: unknown): ProfileType {
  const text = String(value || '').trim().toLowerCase();
  return text === 'project' || text === 'preference' || text === 'term' ? text : 'preference';
}

function cleanRequiredText(value: unknown, label: string): string {
  const text = String(value == null ? '' : value).trim();
  if (!text) throw new Error(`${label} is required`);
  return text.slice(0, 500);
}

function idFor(entry: ProfileEntry): string {
  return encodeURIComponent(`${entry.type}:${entry.scope || 'user'}:${entry.key}`);
}

function entryToItem(entry: ProfileEntry): MemoryItem {
  return {
    id: idFor(entry),
    scope: entry.scope || 'user',
    kind: entry.type,
    title: entry.key,
    content: entry.value,
    evidence: entry.evidence || '',
    enabled: true,
    updatedAt: entry.updatedAt,
  };
}

function parseItemId(id: string): { kind?: ProfileType; scope?: string; title: string } {
  const decoded = decodeURIComponent(String(id || ''));
  const [kind, scope, ...rest] = decoded.split(':');
  const parsed: { kind?: ProfileType; scope?: string; title: string } = {
    kind: normalizeKind(kind),
    title: rest.join(':') || decoded,
  };
  if (scope) parsed.scope = scope;
  return parsed;
}

export function classifyMemoryCandidate(input: Pick<MemoryItemInput, 'title' | 'content' | 'evidence'>): MemoryPolicyDecision {
  const decision = decideMemoryDlp(input);
  return { action: decision.action, sensitivity: decision.sensitivity, reason: decision.reason };
}

// 记忆是否"活跃":启用且未暂停未隐身。读(召回/注入)与写(回写)都以此为总闸,
// 让面板 API、内置分层注入、MASE 记忆桥接对同一个用户开关保持一致语义。
export async function listMemoryItems(
  memoryStore: MemoryStoreLike,
  trustedRoot: string,
  context: Record<string, unknown> = {},
): Promise<MemoryItem[]> {
  const profile = await createUserProfile({ memoryStore }).load(trustedRoot, context);
  return profile.entries.map(entryToItem);
}

export async function upsertMemoryItem(
  memoryStore: MemoryStoreLike,
  trustedRoot: string,
  input: MemoryItemInput,
  context: Record<string, unknown> = {},
): Promise<{ item: MemoryItem; policy: MemoryPolicyDecision; items: MemoryItem[] }> {
  const settings = readMemorySettings(trustedRoot, context);
  if (!isMemoryActive(settings)) {
    throw Object.assign(new Error('memory is disabled, paused, or incognito for this user'), { statusCode: 409 });
  }
  const normalized = {
    type: normalizeKind(input.kind),
    key: cleanRequiredText(input.title, 'memory title'),
    value: cleanRequiredText(input.content, 'memory content'),
    evidence: String(input.evidence || 'explicit_user_confirmation').trim().slice(0, 500) || 'explicit_user_confirmation',
    scope: normalizeScope(input.scope, settings.defaultScope),
  };
  const policy = classifyMemoryCandidate({ title: normalized.key, content: normalized.value, evidence: normalized.evidence });
  if (policy.action === 'deny_write') {
    throw Object.assign(new Error(policy.reason), { statusCode: 400 });
  }
  const profile = await createUserProfile({ memoryStore }).learn(trustedRoot, normalized, context);
  const items = profile.entries.map(entryToItem);
  const item = items.find((entry) => entry.id === idFor({
    type: normalized.type,
    key: normalized.key,
    value: normalized.value,
    evidence: normalized.evidence,
    scope: normalized.scope,
    updatedAt: '',
  })) || entryToItem({ ...normalized, updatedAt: nowIso() });
  return { item, policy, items };
}

export async function deleteMemoryItem(
  memoryStore: MemoryStoreLike,
  trustedRoot: string,
  id: string,
  context: Record<string, unknown> = {},
): Promise<{ removed: number; items: MemoryItem[] }> {
  const parsed = parseItemId(id);
  const result = await createUserProfile({ memoryStore }).forget(
    trustedRoot,
    { type: parsed.kind, key: parsed.title },
    context,
  );
  return { removed: result.removed, items: result.profile.entries.map(entryToItem) };
}

export async function buildMemorySnapshot(
  memoryStore: MemoryStoreLike,
  trustedRoot: string,
  options: { query?: string; context?: Record<string, unknown> } = {},
): Promise<MemorySnapshot> {
  const settings = readMemorySettings(trustedRoot, options.context || {});
  if (!isMemoryActive(settings)) {
    return {
      settings,
      userPreferences: [],
      projectSummary: '',
      workspaceSummary: '',
      recentProgress: [],
      correctionRules: [],
      artifactHints: [],
      capabilityState: [],
      used: [],
      omitted: [{ reason: settings.incognito ? 'incognito' : settings.paused ? 'paused' : 'disabled', count: 1 }],
    };
  }
  const profile = createUserProfile({ memoryStore });
  const recalled = await profile.recall(trustedRoot, {
    query: options.query || '',
    limit: 12,
    context: options.context || {},
  });
  const used = recalled.entries.map(entryToItem);
  return {
    settings,
    userPreferences: used.filter((item) => item.kind === 'preference'),
    projectSummary: recalled.project,
    workspaceSummary: '',
    recentProgress: used.filter((item) => item.kind === 'project'),
    correctionRules: used.filter((item) => /不要|禁止|必须|纠错|错/.test(`${item.title} ${item.content}`)),
    artifactHints: [],
    capabilityState: used.filter((item) => /pack|组件|能力|安装/.test(`${item.title} ${item.content}`.toLowerCase())),
    used,
    omitted: [],
  };
}
