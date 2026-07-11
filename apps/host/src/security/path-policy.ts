// 路径安全策略(host · L0 基础层,无内部依赖)
// ---------------------------------------------------------------------------
// 职责:把外部传入的任意路径收敛进「可信根 trustedRoot」之内,并拦截对敏感文件/
//       目录(.ssh、凭据、.env、私钥等)的访问。是所有文件读写工具的安全闸门——
//       「路径 jail」就落在这里(参见 plan/01 D.12)。
// 依赖:仅 node:fs / node:path(L0 不依赖任何内部模块)。
// 导出:canonicalizePath / resolveWithinRoot / isSensitivePath /
//       isWorkspaceIgnoredPath / assertTrustedPath / assertTrustedPathForCreate /
//       assertReadableWorkspacePath / isTrustedPath。

import fs from 'node:fs';
import path from 'node:path';
import {
  SENSITIVE_EXTENSIONS,
  SENSITIVE_FILENAMES,
  SENSITIVE_SEGMENTS,
  WORKSPACE_IGNORED_SEGMENTS,
} from './path-policy-constants.js';

function isWindows(): boolean {
  return process.platform === 'win32';
}

/** 归一化用于「比较」的路径:转正斜杠;Windows 上大小写不敏感故转小写。 */
function normalizeForCompare(p: string): string {
  const replaced = path.resolve(p).replace(/[\\]/g, '/');
  return isWindows() ? replaced.toLowerCase() : replaced;
}

/**
 * Windows 文件名等价归一:把 basename / 路径段收敛到「系统真正打开的有效名」——
 * 剥掉末尾的点与空格(Win32 打开时忽略),并去掉 NTFS 数据流后缀(`name::$DATA` 即文件本体)。
 * **仅对 win32 生效**:POSIX 上 `:` 与末尾点/空格是合法且不同的文件名,不能归一(否则会误伤合法文件)。
 * 用于敏感匹配之前——否则 `.env `(尾空格)、`id_ecdsa.`(尾点)、`credentials.json::$DATA`(ADS)
 * 这类「等价但不同字面」的写法会绕过下面的精确匹配(realpath 不会剥末尾点/空格)。
 */
function win32EffectiveName(base: string): string {
  if (!isWindows()) return base;
  const noStream = base.split(':')[0] ?? base;
  return noStream.replace(/[. ]+$/u, '');
}

function realpath(p: string): string {
  return fs.realpathSync.native ? fs.realpathSync.native(p) : fs.realpathSync(p);
}

/**
 * 规范化为「真实绝对路径」:解析符号链接/junction/Windows 8.3 短名。
 * 若路径尚未创建,回退到最近的已存在祖先目录再拼回缺失段(供写入前校验)。
 */
export function canonicalizePath(input: string): string {
  const resolved = path.resolve(input);
  try {
    return realpath(resolved);
  } catch {
    // 路径尚不存在时,向上找到最近已存在祖先;这样前缀里的 Windows 8.3 短名、
    // junction/symlink 仍会被规范化,再把缺失段拼回去。
    let cur = resolved;
    const missing: string[] = [];
    let guard = 0;
    while (guard < 4096) {
      const parent = path.dirname(cur);
      if (parent === cur) break; // 已走到文件系统根。
      missing.unshift(path.basename(cur));
      cur = parent;
      guard += 1;
      try {
        const realAncestor = realpath(cur);
        return path.join(realAncestor, ...missing);
      } catch {
        // 继续向上找最近的已存在祖先。
      }
    }
    return resolved;
  }
}

/** 取「可信根之下」的路径段序列;给定 relativeTo 时只检查根以内,否则取全路径段。 */
function segmentsBelowRoot(inputPath: string, relativeTo: string | null = null): string[] {
  const normalized = normalizeForCompare(inputPath);
  if (!relativeTo) return normalized.split('/').filter(Boolean);
  const normRoot = normalizeForCompare(relativeTo);
  const rootWithSep = normRoot.endsWith('/') ? normRoot : `${normRoot}/`;
  if (normalized === normRoot) return [];
  if (normalized.startsWith(rootWithSep)) {
    return normalized.slice(rootWithSep.length).split('/').filter(Boolean);
  }
  return normalized.split('/').filter(Boolean);
}

/** 把相对路径锚定到可信根、绝对路径原样解析(尚不做安全断言)。 */
export function resolveWithinRoot(candidatePath: string, trustedRoot: string): string {
  return path.isAbsolute(candidatePath)
    ? path.resolve(candidatePath)
    : path.resolve(trustedRoot, candidatePath);
}

// 判断路径是否「敏感」:文件名/扩展名命中黑名单,或路径段命中敏感目录。
// `relativeTo` 只收窄「目录段」检查范围到 trusted root 之下;文件名/扩展名仍始终检查目标本身。
export function isSensitivePath(inputPath: string, relativeTo: string | null = null): boolean {
  const normalized = normalizeForCompare(inputPath);
  // 先把 basename 归一到 Windows 有效名,否则尾空格/尾点/ADS 变体会绕过下面的精确匹配。
  const lowerBase = win32EffectiveName(path.basename(normalized)).toLowerCase();
  const lowerExt = path.extname(lowerBase).toLowerCase();

  // 目标文件名/扩展名总是检查,即使 relativeTo 把目录段范围收窄。
  if (lowerBase === 'id_rsa' || lowerBase.startsWith('id_rsa')) {
    return true;
  }
  if (SENSITIVE_EXTENSIONS.has(lowerExt)) {
    return true;
  }
  if (SENSITIVE_FILENAMES.has(lowerBase)) {
    return true;
  }

  // 给定 trusted root 时,目录段敏感性只看根以内的相对段。
  const segments = segmentsBelowRoot(normalized, relativeTo);

  for (const segment of segments) {
    // 敏感目录名大小写不敏感;并对每段做 Windows 有效名归一,防止 `.ssh `/`.aws.` 这类等价目录段绕过。
    const seg = win32EffectiveName(segment).toLowerCase();
    if (SENSITIVE_SEGMENTS.has(seg)) {
      return true;
    }
    if (seg === '.env' || seg.startsWith('.env')) {
      return true;
    }
  }

  return false;
}

/** 工作区检索时是否应忽略该路径:隐藏目录、依赖/产物目录,或敏感路径。 */
export function isWorkspaceIgnoredPath(inputPath: string, relativeTo: string | null = null): boolean {
  const segments = segmentsBelowRoot(inputPath, relativeTo);
  for (const segment of segments) {
    const lower = segment.toLowerCase();
    if (lower.startsWith('.')) {
      return true;
    }
    if (WORKSPACE_IGNORED_SEGMENTS.has(lower)) {
      return true;
    }
  }
  return isSensitivePath(inputPath, relativeTo);
}

/** 断言为「可读工作区路径」:先过可信根校验,再排除被忽略/敏感路径;违反即抛错。 */
export function assertReadableWorkspacePath(candidatePath: string, trustedRoot: string): string {
  const safe = assertTrustedPath(candidatePath, trustedRoot);
  // `safe` 已经 realpath 规范化;root 也必须规范化,否则 isWorkspaceIgnoredPath 的
  // “root 下方路径段” 范围判断会匹配不上。
  // 若 root 仍是 8.3 短名(如 ADMINI~1)或 symlink/junction,前缀匹配会失败,
  // 段/敏感检查会退回整条路径检查,导致合法工作区只要位于 AppData/Temp 下就被误封。
  const canonicalRoot = canonicalizePath(trustedRoot);
  if (isWorkspaceIgnoredPath(safe, canonicalRoot)) {
    throw new Error(`Workspace ignored or sensitive path blocked by policy: ${candidatePath}`);
  }
  return safe;
}

/**
 * 断言路径在可信根「之内」且非敏感,返回规范化后的安全绝对路径;越界/敏感即抛错。
 * 这是读取类工具的核心闸门(写入新文件用 assertTrustedPathForCreate)。
 */
export function assertTrustedPath(candidatePath: string, trustedRoot: string): string {
  const candidate = resolveWithinRoot(candidatePath, trustedRoot);
  const root = canonicalizePath(trustedRoot);
  const absoluteCandidate = canonicalizePath(candidate);

  const normalizedRoot = normalizeForCompare(root);
  const normalizedCandidate = normalizeForCompare(absoluteCandidate);

  const rootWithSep = normalizedRoot.endsWith('/') ? normalizedRoot : `${normalizedRoot}/`;
  const isInside =
    normalizedCandidate === normalizedRoot ||
    normalizedCandidate.startsWith(rootWithSep);
  if (!isInside) {
    throw new Error(`Path escaped trusted root: ${candidatePath}`);
  }

  if (isSensitivePath(absoluteCandidate, root)) {
    throw new Error(`Sensitive path blocked by policy: ${candidatePath}`);
  }

  return absoluteCandidate;
}

// 写入专用变体:目标文件「可能尚不存在」。普通 assertTrustedPath 对不存在路径
// 调 realpath 不会解析 junction,会让 `根/<指向外部的junction>/新文件` 漏过;这里
// 改为向上找到最近的「已存在祖先」并对其规范化,再要求真实父目录落在真实根内。
// 返回值是「真实父目录 + 缺失段」拼出的安全绝对路径。
export function assertTrustedPathForCreate(candidatePath: string, trustedRoot: string): string {
  const candidate = resolveWithinRoot(candidatePath, trustedRoot);
  const rootReal = canonicalizePath(trustedRoot);

  let cur = candidate;
  const missing: string[] = [];
  let guard = 0;
  while (!fs.existsSync(cur) && guard < 4096) {
    missing.unshift(path.basename(cur));
    const next = path.dirname(cur);
    if (next === cur) break;
    cur = next;
    guard += 1;
  }
  const parentReal = canonicalizePath(cur);
  const finalPath = missing.length ? path.join(parentReal, ...missing) : parentReal;

  const normRoot = normalizeForCompare(rootReal);
  const normCandidate = normalizeForCompare(finalPath);
  const rootWithSep = normRoot.endsWith('/') ? normRoot : `${normRoot}/`;
  const inside = normCandidate === normRoot || normCandidate.startsWith(rootWithSep);
  if (!inside) {
    throw new Error(`Path escaped trusted root: ${candidatePath}`);
  }

  if (isSensitivePath(finalPath, rootReal)) {
    throw new Error(`Sensitive path blocked by policy: ${candidatePath}`);
  }
  return finalPath;
}

/** assertTrustedPath 的「布尔版」:可信且非敏感返回 true,否则 false(不抛错)。 */
export function isTrustedPath(candidatePath: string, trustedRoot: string): boolean {
  try {
    assertTrustedPath(candidatePath, trustedRoot);
    return true;
  } catch {
    return false;
  }
}
