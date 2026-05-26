// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { isWorkspaceIgnoredPath } from '../security/path-policy.js';

/** @param {unknown} text @param {number} [max] */
export function clip(text, max = 8000) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max)}\n…(已截断 ${s.length - max} 字符)` : s;
}

/** @param {unknown} pattern */
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

/** @param {string} root @param {string} current @param {string[]} out @param {number} limit */
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
