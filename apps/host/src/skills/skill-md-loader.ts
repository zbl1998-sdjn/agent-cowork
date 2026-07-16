// Agent Skills(SKILL.md)标准加载器(host · L1 领域层 · skills)
// ---------------------------------------------------------------------------
// 职责:从 trusted root 下 `.AgentCowork/skills/<name>/SKILL.md` 发现并解析
//       符合 agentskills.io 开放标准的技能包(YAML frontmatter 的 name/description
//       子集 + Markdown 指令体),供系统提示注入目录、LoadSkill 工具按需读全文。
//       第一阶段只做"指令注入",不执行技能包附带脚本。
// 安全:技能包内容属不可信输入——目录/文件均拒绝 symlink,SKILL.md 与参考文件
//       有字节上限,name 必须匹配目录名,注入系统提示的字段做单行化清洗;
//       `.AgentCowork` 对原生文件工具封锁,本加载器是技能包的唯一读取入口。
// 依赖:node:fs / node:path。导出:isValidSkillPackName、parseSkillMd、
//       discoverSkillPacks、readSkillPackFile 与相关类型。
import fs from 'node:fs';
import path from 'node:path';

export type SkillPackDescriptor = { name: string; description: string };
export type SkillPackDiscovery = { packs: SkillPackDescriptor[]; warnings: string[] };
export type ParsedSkillMd = { fields: Record<string, string>; body: string };

const MAX_PACKS = 50;
const MAX_SKILL_MD_BYTES = 256 * 1024;
const MAX_REFERENCE_BYTES = 256 * 1024;
const MAX_BODY_CHARS = 24_000;
const MAX_DESCRIPTION_CHARS = 1024;
const TRUNCATION_NOTE = '\n…(内容过长,已截断)';

// 系统提示注入面清洗:C0/C1 控制符与 bidi/零宽等不可见指令字符(码点构造,源码不含原始字符)。
const STRIP_CODEPOINTS = [
  0x00ad, 0x061c,
  0x200b, 0x200c, 0x200d, 0x200e, 0x200f,
  0x202a, 0x202b, 0x202c, 0x202d, 0x202e,
  0x2060, 0x2066, 0x2067, 0x2068, 0x2069,
  0xfeff,
];
const STRIP_PATTERN = new RegExp(
  '[' + String.fromCharCode(0x00) + '-' + String.fromCharCode(0x1f)
  + String.fromCharCode(0x7f) + '-' + String.fromCharCode(0x9f)
  + STRIP_CODEPOINTS.map((cp) => String.fromCharCode(cp)).join('') + ']',
  'g',
);

function sanitizeInline(value: string): string {
  return value.replace(STRIP_PATTERN, ' ').replace(/\s+/g, ' ').trim();
}

/** agentskills.io 规范的 name 约束:1-64 位小写字母/数字/连字符,不以连字符开头结尾,无连续连字符。 */
export function isValidSkillPackName(name: string): boolean {
  if (typeof name !== 'string' || name.length < 1 || name.length > 64) return false;
  if (!/^[a-z0-9-]+$/.test(name)) return false;
  if (name.startsWith('-') || name.endsWith('-') || name.includes('--')) return false;
  return true;
}

/**
 * 解析 SKILL.md:提取 YAML frontmatter 的顶层单行标量字段(name/description 等,
 * 支持可选引号),嵌套结构(如 metadata 映射)按规范允许但本实现忽略;返回字段表与
 * frontmatter 之后的 Markdown 指令体。格式不合法返回 null。
 */
export function parseSkillMd(text: string): ParsedSkillMd | null {
  const normalized = text.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return null;
  const end = normalized.indexOf('\n---', 4);
  if (end < 0) return null;
  const afterMarker = normalized.indexOf('\n', end + 1);
  const frontmatter = normalized.slice(4, end);
  const body = afterMarker < 0 ? '' : normalized.slice(afterMarker + 1);
  const fields: Record<string, string> = {};
  for (const line of frontmatter.split('\n')) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!match || match[1] === undefined || match[2] === undefined) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"') && value.length >= 2)
      || (value.startsWith("'") && value.endsWith("'") && value.length >= 2)) {
      value = value.slice(1, -1);
    }
    fields[match[1]] = value;
  }
  return { fields, body };
}

function skillPacksRoot(trustedRoot: string): string {
  return path.join(path.resolve(trustedRoot), '.AgentCowork', 'skills');
}

function statNonSymlink(target: string): fs.Stats | null {
  try {
    const stats = fs.lstatSync(target);
    return stats.isSymbolicLink() ? null : stats;
  } catch {
    return null;
  }
}

function readSkillMdOf(packDir: string, packName: string): { parsed: ParsedSkillMd } | { warning: string } {
  const skillMdPath = path.join(packDir, 'SKILL.md');
  const stats = statNonSymlink(skillMdPath);
  if (!stats || !stats.isFile()) return { warning: `${packName}: 缺少 SKILL.md 常规文件(或为 symlink)` };
  if (stats.size > MAX_SKILL_MD_BYTES) return { warning: `${packName}: SKILL.md 超过 ${MAX_SKILL_MD_BYTES} 字节上限` };
  const parsed = parseSkillMd(fs.readFileSync(skillMdPath, 'utf8'));
  if (!parsed) return { warning: `${packName}: SKILL.md 缺少合法 YAML frontmatter` };
  return { parsed };
}

/** 扫描 `.AgentCowork/skills/`,返回通过规范校验的技能包目录(name+description)与逐包跳过原因。 */
export function discoverSkillPacks(trustedRoot: string): SkillPackDiscovery {
  const packs: SkillPackDescriptor[] = [];
  const warnings: string[] = [];
  const root = skillPacksRoot(trustedRoot);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return { packs, warnings };
  }
  const dirNames = entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort();
  for (const dirName of dirNames) {
    if (packs.length >= MAX_PACKS) {
      warnings.push(`技能包数量超过 ${MAX_PACKS} 上限,其余目录已忽略`);
      break;
    }
    if (!isValidSkillPackName(dirName)) {
      warnings.push(`${dirName}: 目录名不符合技能包命名规范,已跳过`);
      continue;
    }
    const result = readSkillMdOf(path.join(root, dirName), dirName);
    if ('warning' in result) {
      warnings.push(result.warning);
      continue;
    }
    const name = result.parsed.fields.name || '';
    const description = sanitizeInline(result.parsed.fields.description || '');
    if (name !== dirName) {
      warnings.push(`${dirName}: frontmatter name(${name})与目录名不一致,已跳过`);
      continue;
    }
    if (!description || description.length > MAX_DESCRIPTION_CHARS) {
      warnings.push(`${dirName}: description 缺失或超过 ${MAX_DESCRIPTION_CHARS} 字符,已跳过`);
      continue;
    }
    packs.push({ name, description });
  }
  return { packs, warnings };
}

function clipBody(text: string): string {
  return text.length > MAX_BODY_CHARS ? text.slice(0, MAX_BODY_CHARS) + TRUNCATION_NOTE : text;
}

/**
 * 读取技能包内容:不传 file 返回 SKILL.md 的指令体(去 frontmatter,超长截断);
 * file 仅允许 `references/<单层文件名>`(读参考文档),拒绝 symlink/越界/超限。
 * 违规抛 Error,由工具层转为 { error }。
 */
export function readSkillPackFile(trustedRoot: string, packName: string, relFile?: string): { name: string; file: string; content: string } {
  if (!isValidSkillPackName(packName)) throw new Error(`技能包名不合法: ${packName}`);
  const packDir = path.join(skillPacksRoot(trustedRoot), packName);
  const dirStats = statNonSymlink(packDir);
  if (!dirStats || !dirStats.isDirectory()) throw new Error(`技能包不存在: ${packName}`);
  if (relFile === undefined || relFile === '' || relFile === 'SKILL.md') {
    const result = readSkillMdOf(packDir, packName);
    if ('warning' in result) throw new Error(result.warning);
    return { name: packName, file: 'SKILL.md', content: clipBody(result.parsed.body) };
  }
  const normalizedRel = String(relFile).replace(/\\/g, '/');
  if (!/^references\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(normalizedRel) || normalizedRel.includes('..')) {
    throw new Error(`只允许读取 references/ 下的单层参考文件: ${relFile}`);
  }
  const target = path.join(packDir, normalizedRel);
  if (!(path.resolve(target).startsWith(path.resolve(packDir) + path.sep))) {
    throw new Error(`参考文件路径越界: ${relFile}`);
  }
  const stats = statNonSymlink(target);
  if (!stats || !stats.isFile()) throw new Error(`参考文件不存在(或为 symlink): ${relFile}`);
  if (stats.size > MAX_REFERENCE_BYTES) throw new Error(`参考文件超过 ${MAX_REFERENCE_BYTES} 字节上限: ${relFile}`);
  return { name: packName, file: normalizedRel, content: clipBody(fs.readFileSync(target, 'utf8')) };
}
