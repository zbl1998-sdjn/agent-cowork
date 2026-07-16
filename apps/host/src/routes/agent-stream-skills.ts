// Agent 技能注入解析(host · L3 路由层 · routes)
// ---------------------------------------------------------------------------
// 职责:为 /api/agent/chat/stream 解析两类技能注入——①内置 recipe 技能目录
//       (skillRegistry.enabledSkills → 系统提示 skills 清单);②SKILL.md 标准
//       技能包(discoverSkillPacks → 系统提示目录 + LoadSkill 只读读取器)。
//       模板模式下两者都不注入。纯本地文件/注册表访问,零出站。
// 依赖:L1 skills/skill-md-loader。导出:resolveAgentSkills、resolveAgentSkillPacks。
import { discoverSkillPacks, readSkillPackFile, type SkillPackDescriptor } from '../skills/skill-md-loader.js';
import { readDisabledSkillPacks } from '../skills/skill-pack-settings.js';
import type { SkillPackReader } from '../engine/agent/toolset-builder.js';
import { omitUndefined } from '../util/object.js';

type EnabledSkillsRegistry = {
  enabledSkills?: () => Array<{ id: unknown; name: unknown; description?: unknown }>;
};

export type ResolvedAgentSkill = { id: string; name: string; description?: string };

/** 内置 recipe 技能目录:模板模式或注册表缺失时为空;字段做字符串化清洗。 */
export function resolveAgentSkills(
  skillRegistry: EnabledSkillsRegistry | null | undefined,
  templateActive: boolean,
): ResolvedAgentSkill[] {
  if (templateActive || !skillRegistry || typeof skillRegistry.enabledSkills !== 'function') return [];
  return skillRegistry.enabledSkills()
    .map((sk) => omitUndefined({
      id: String(sk.id || ''),
      name: String(sk.name || ''),
      description: typeof sk.description === 'string' ? sk.description : undefined,
    }) as ResolvedAgentSkill)
    .filter((sk) => sk.id && sk.name);
}

export type ResolvedSkillPacks = { packs: SkillPackDescriptor[]; reader: SkillPackReader | null };

/** SKILL.md 技能包(渐进披露):目录进系统提示,全文只经 LoadSkill 读取;无包时 reader 为 null 不挂工具。
 * 用户在设置页禁用的包(skill-pack-settings 持久名单)整体剔除——既不进目录也不可被 LoadSkill 读到。 */
export function resolveAgentSkillPacks(trustedRoot: string, templateActive: boolean): ResolvedSkillPacks {
  if (templateActive) return { packs: [], reader: null };
  const disabled = readDisabledSkillPacks(trustedRoot);
  const packs = discoverSkillPacks(trustedRoot).packs.filter((pack) => !disabled.has(pack.name));
  if (!packs.length) return { packs, reader: null };
  const active = new Set(packs.map((pack) => pack.name));
  return {
    packs,
    reader: {
      list: () => packs,
      read: (name: string, file?: string) => {
        if (!active.has(name)) throw new Error(`技能包不可用(未发现或已被用户禁用): ${name}`);
        return readSkillPackFile(trustedRoot, name, file);
      },
    },
  };
}
