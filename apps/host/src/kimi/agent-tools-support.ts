// Agent 工具的底层支撑:文本截断、glob 转正则、工作区文件遍历(host · L1 领域层)
// ---------------------------------------------------------------------------
// 职责:为 agent-tools.js 提供无状态小工具——输出截断、最小化 glob→RegExp 转换、
//       受安全策略过滤的工作区文件递归遍历。
// 依赖:标准库(node:fs / node:path)、L0 安全层 ../security/path-policy.js。
// 导出:clip(截断)、globToRegExp(glob 转正则)、walkFiles(遍历文件)。
import fs from 'node:fs';
import path from 'node:path';
import { isWorkspaceIgnoredPath } from '../security/path-policy.js';

/** 把文本截断到 max 字符并附加截断提示,防止工具输出过大撑爆上下文。 */
export function clip(text: unknown, max = 8000): string {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max)}\n…(已截断 ${s.length - max} 字符)` : s;
}

/** 把最小化 glob 模式(** / * / ?)编译成锚定的正则,用于文件名匹配。 */
export function globToRegExp(pattern: unknown): RegExp {
  // 最小 glob 语义:** 匹配任意路径,* 匹配单段任意字符,? 匹配单个字符。
  let re = '';
  const p = String(pattern).replace(/\\/g, '/');
  for (let i = 0; i < p.length; i += 1) {
    const c = p[i] ?? '';
    if (c === '*') {
      if (p[i + 1] === '*') { re += '.*'; i += 1; if (p[i + 1] === '/') i += 1; }
      else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if ('.+^${}()|[]\\'.includes(c)) re += `\\${c}`;
    else re += c;
  }
  return new RegExp(`^${re}$`);
}

/** 递归收集工作区文件相对路径(跳过软链与被忽略路径),到达上限即停。 */
export function walkFiles(
  root: string,
  current: string,
  out: string[],
  limit: number,
  includeEntry?: (fullPath: string, kind: 'file' | 'directory') => boolean,
): void {
  if (out.length >= limit || !fs.existsSync(current)) return;
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    if (out.length >= limit || entry.isSymbolicLink()) continue;
    const full = path.join(current, entry.name);
    if (isWorkspaceIgnoredPath(full, root)) continue;
    if (entry.isDirectory()) {
      if (!includeEntry || includeEntry(full, 'directory')) {
        walkFiles(root, full, out, limit, includeEntry);
      }
    } else if (entry.isFile() && (!includeEntry || includeEntry(full, 'file'))) {
      out.push(path.relative(root, full).replace(/\\/g, '/'));
    }
  }
}
