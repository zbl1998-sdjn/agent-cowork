// 记忆 API(UI · 传输层 · lib/api)
// ---------------------------------------------------------------------------
// 职责:读取/学习/遗忘用户画像记忆条目(术语/项目/偏好),并按 trustedRoot 与查询召回。
// 依赖/对应路由:GET /api/memory/profile、POST /api/memory/profile/learn、POST /api/memory/profile/forget。导出:getMemoryProfile / learnMemoryProfile / forgetMemoryProfile + 相关类型。
import { getJson, postJson } from './transport';

export type MemoryProfileType = 'term' | 'project' | 'preference';

export interface MemoryProfileEntry {
  type: MemoryProfileType;
  key: string;
  value: string;
  evidence: string;
  scope?: string;
  updatedAt?: string;
}

export interface MemoryProfileResponse {
  trustedRoot: string;
  profile: { version: number; entries: MemoryProfileEntry[] };
  recall: { project: string; terms: string[]; entries: MemoryProfileEntry[] };
}

function queryString(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) search.set(key, value);
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

export function getMemoryProfile(trustedRoot?: string, query?: string): Promise<MemoryProfileResponse> {
  return getJson(`/api/memory/profile${queryString({ trustedRoot, query })}`);
}

export function learnMemoryProfile(
  entry: Omit<MemoryProfileEntry, 'updatedAt'>,
  trustedRoot?: string,
): Promise<MemoryProfileResponse> {
  return postJson('/api/memory/profile/learn', { ...entry, trustedRoot });
}

export function forgetMemoryProfile(
  filter: { type?: MemoryProfileType; key?: string },
  trustedRoot?: string,
): Promise<{ removed: number; profile: { version: number; entries: MemoryProfileEntry[] } }> {
  return postJson('/api/memory/profile/forget', { ...filter, trustedRoot });
}
