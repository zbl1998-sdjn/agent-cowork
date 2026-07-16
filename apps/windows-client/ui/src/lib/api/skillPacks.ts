// 技能包 API(UI · 传输层 · lib/api)
// ---------------------------------------------------------------------------
// 职责:列出当前工作区发现的 SKILL.md 标准技能包(含启用状态与跳过原因),并按 name 开关。
// 对应路由:/api/skill-packs、/api/skill-packs/:name/toggle。
import { getJson, postJson } from './transport';

export type SkillPack = { name: string; description: string; enabled: boolean };
export type SkillPacksResponse = { packs: SkillPack[]; warnings: string[] };

function normalize(raw: { packs?: unknown; warnings?: unknown }): SkillPacksResponse {
  const packs = Array.isArray(raw.packs)
    ? raw.packs
      .map((item) => {
        const record = item && typeof item === 'object' ? item as Record<string, unknown> : {};
        return {
          name: String(record.name || ''),
          description: String(record.description || ''),
          enabled: record.enabled !== false,
        };
      })
      .filter((pack) => pack.name)
    : [];
  const warnings = Array.isArray(raw.warnings) ? raw.warnings.map((w) => String(w)).filter(Boolean) : [];
  return { packs, warnings };
}

export async function getSkillPacks(): Promise<SkillPacksResponse> {
  return normalize(await getJson<{ packs?: unknown; warnings?: unknown }>('/api/skill-packs'));
}

export async function toggleSkillPack(name: string, enabled: boolean): Promise<SkillPacksResponse> {
  return normalize(await postJson<{ packs?: unknown; warnings?: unknown }>(
    `/api/skill-packs/${encodeURIComponent(name)}/toggle`,
    { enabled },
  ));
}
