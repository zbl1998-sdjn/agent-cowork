// @ts-check
// Agent 工具的底层支撑:文本截断、glob 转正则、工作区文件遍历(host · L1 领域层)
// ---------------------------------------------------------------------------
// 职责:为 agent-tools.js 提供无状态小工具——输出截断、最小化 glob→RegExp 转换、
//       受安全策略过滤的工作区文件递归遍历。
// 依赖:标准库(node:fs / node:path)、L0 安全层 ../security/path-policy.js。
// 导出:clip(截断)、globToRegExp(glob 转正则)、walkFiles(遍历文件)。
import fs from 'node:fs';
import path from 'node:path';
import { isWorkspaceIgnoredPath } from '../security/path-policy.js';

/** 把文本截断到 max 字符并附加截断提示,防止工具输出过大撑爆上下文。 @param {unknown} text @param {number} [max] */
export function clip(text, max = 8000) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max)}\n…(已截断 ${s.length - max} 字符)` : s;
}

/** 把最小化 glob 模式(** / * / ?)编译成锚定的正则,用于文件名匹配。 @param {unknown} pattern */
export function globToRegExp(pattern) {
  // Minimal glob: ** -> any path, * -> any segment chars, ? -> one char.
  let re = '';
  const p = String(pattern).replace(/\\/g, '/');
  for (let i = 0; i < p.length; i += 1) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') { re += '.*'; i += 1; if (p[i + 1] === '/') i += 1; }
      else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if ('.+^${}()|[]\\'.includes(c)) re += `\\${c}`;
    else re += c;
  }
  return new RegExp(`^${re}$`);
}

/** 递归收集工作区文件相对路径(跳过软链与被忽略路径),到达上限即停。 @param {string} root @param {string} current @param {string[]} out @param {number} limit */
export function walkFiles(root, current, out, limit) {
  if (out.length >= limit || !fs.existsSync(current)) return;
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    if (out.length >= limit || entry.isSymbolicLink()) continue;
    const full = path.join(current, entry.name);
    if (isWorkspaceIgnoredPath(full, root)) continue;
    if (entry.isDirectory()) walkFiles(root, full, out, limit);
    else if (entry.isFile()) out.push(path.relative(root, full).replace(/\\/g, '/'));
  }
}
