// 技能包启停持久化(host · L1 领域层 · skills)
// ---------------------------------------------------------------------------
// 职责:按工作区(trustedRoot)持久化 SKILL.md 技能包的 disabled 名单——
//       `.AgentCowork/settings/skill-packs.json`。默认全部启用;文件缺失/损坏
//       安全降级为空名单。名单读写都过技能包命名校验,拒绝越界名字混入。
// 依赖:node:fs / node:path + 同域 skill-md-loader 的命名校验。
// 导出:readDisabledSkillPacks、setSkillPackEnabled。
import fs from 'node:fs';
import path from 'node:path';
import { isValidSkillPackName } from './skill-md-loader.js';

type HttpError = Error & { statusCode?: number };

function settingsPath(trustedRoot: string): string {
  return path.join(path.resolve(trustedRoot), '.AgentCowork', 'settings', 'skill-packs.json');
}

/** 读取本工作区禁用的技能包名单;文件缺失/损坏/含非法名时安全降级(忽略非法项)。 */
export function readDisabledSkillPacks(trustedRoot: string): Set<string> {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath(trustedRoot), 'utf8')) as { disabled?: unknown };
    const list = Array.isArray(raw?.disabled) ? raw.disabled : [];
    return new Set(list.filter((name): name is string => typeof name === 'string' && isValidSkillPackName(name)));
  } catch {
    return new Set();
  }
}

/** 开关一个技能包并持久化;返回最新的 disabled 名单(排序后)。非法名报 400。 */
export function setSkillPackEnabled(trustedRoot: string, name: string, enabled: boolean): string[] {
  if (!isValidSkillPackName(name)) {
    const err = new Error(`技能包名不合法: ${name}`) as HttpError;
    err.statusCode = 400;
    throw err;
  }
  const disabled = readDisabledSkillPacks(trustedRoot);
  if (enabled) {
    disabled.delete(name);
  } else {
    disabled.add(name);
  }
  const sorted = [...disabled].sort();
  const file = settingsPath(trustedRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ disabled: sorted, updatedAt: new Date().toISOString() }, null, 2) + '\n', 'utf8');
  return sorted;
}
