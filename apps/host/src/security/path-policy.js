// @ts-check
//
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

// 敏感「目录名」黑名单:路径中任意一段命中即视为敏感(凭据库、密钥目录等)。
const SENSITIVE_SEGMENTS = new Set([
  '.aws',
  '.azure',
  '.docker',
  '.git',
  '.gnupg',
  '.kube',
  '.ssh',
  '.env',
  'appdata',
  'credentials',
  '.kimi',
]);

// 敏感「文件名」黑名单:即便落在可信根内,这些文件也不允许被工具读写。
const SENSITIVE_FILENAMES = new Set([
  '.env',
  '.netrc',
  '.npmrc',
  '.pypirc',
  'credentials.json',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
]);

// 敏感「扩展名」黑名单:证书/私钥文件。
const SENSITIVE_EXTENSIONS = new Set(['.pem', '.key', '.p12', '.pfx']);
// 工作区检索时应忽略的目录(体积大且无业务价值),用于「可读工作区」收窄。
const WORKSPACE_IGNORED_SEGMENTS = new Set(['node_modules', 'dist', 'build', 'coverage']);

/** @returns {boolean} */
function isWindows() {
  return process.platform === 'win32';
}

/** 归一化用于「比较」的路径:转正斜杠;Windows 上大小写不敏感故转小写。 @param {string} p @returns {string} */
function normalizeForCompare(p) {
  const replaced = path.resolve(p).replace(/[\\]/g, '/');
  return isWindows() ? replaced.toLowerCase() : replaced;
}

/** @param {string} p @returns {string} */
function realpath(p) {
  return fs.realpathSync.native ? fs.realpathSync.native(p) : fs.realpathSync(p);
}

/**
 * 规范化为「真实绝对路径」:解析符号链接/junction/Windows 8.3 短名。
 * 若路径尚未创建,回退到最近的已存在祖先目录再拼回缺失段(供写入前校验)。
 * @param {string} input @returns {string}
 */
export function canonicalizePath(input) {
  const resolved = path.resolve(input);
  try {
    return realpath(resolved);
  } catch {
    // Resolve the nearest existing ancestor so Windows 8.3 names and junctions
    // in the prefix are canonicalized for not-yet-created paths.
    let cur = resolved;
    const missing = /** @type {string[]} */ ([]);
    let guard = 0;
    while (guard < 4096) {
      const parent = path.dirname(cur);
      if (parent === cur) break; // reached the filesystem root
      missing.unshift(path.basename(cur));
      cur = parent;
      guard += 1;
      try {
        const realAncestor = realpath(cur);
        return path.join(realAncestor, ...missing);
      } catch {
        // keep walking up to the nearest existing ancestor
      }
    }
    return resolved;
  }
}

/** 取「可信根之下」的路径段序列;给定 relativeTo 时只检查根以内,否则取全路径段。 @param {string} inputPath @param {string | null} [relativeTo] @returns {string[]} */
function segmentsBelowRoot(inputPath, relativeTo = null) {
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

/** 把相对路径锚定到可信根、绝对路径原样解析(尚不做安全断言)。 @param {string} candidatePath @param {string} trustedRoot @returns {string} */
export function resolveWithinRoot(candidatePath, trustedRoot) {
  return path.isAbsolute(candidatePath)
    ? path.resolve(candidatePath)
    : path.resolve(trustedRoot, candidatePath);
}

// 判断路径是否「敏感」:文件名/扩展名命中黑名单,或路径段命中敏感目录。
// `relativeTo` scopes directory-segment checks below the trusted root, while
// filename/extension checks still apply to the target itself.
/** @param {string} inputPath @param {string | null} [relativeTo] @returns {boolean} */
export function isSensitivePath(inputPath, relativeTo = null) {
  const normalized = normalizeForCompare(inputPath);
  const lowerBase = path.basename(normalized).toLowerCase();
  const lowerExt = path.extname(lowerBase).toLowerCase();

  // Target filename / extension — always checked.
  if (lowerBase === 'id_rsa' || lowerBase.startsWith('id_rsa')) {
    return true;
  }
  if (SENSITIVE_EXTENSIONS.has(lowerExt)) {
    return true;
  }
  if (SENSITIVE_FILENAMES.has(lowerBase)) {
    return true;
  }

  // Scope the directory-segment checks to below the trusted root when provided.
  const segments = segmentsBelowRoot(normalized, relativeTo);

  for (const segment of segments) {
    // Directory sensitivity is case-insensitive; containment stays platform
    // sensitive via normalizeForCompare.
    const seg = segment.toLowerCase();
    if (SENSITIVE_SEGMENTS.has(seg)) {
      return true;
    }
    if (seg === '.env' || seg.startsWith('.env')) {
      return true;
    }
  }

  return false;
}

/** 工作区检索时是否应忽略该路径:隐藏目录、依赖/产物目录,或敏感路径。 @param {string} inputPath @param {string | null} [relativeTo] @returns {boolean} */
export function isWorkspaceIgnoredPath(inputPath, relativeTo = null) {
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

/** 断言为「可读工作区路径」:先过可信根校验,再排除被忽略/敏感路径;违反即抛错。 @param {string} candidatePath @param {string} trustedRoot @returns {string} */
export function assertReadableWorkspacePath(candidatePath, trustedRoot) {
  const safe = assertTrustedPath(candidatePath, trustedRoot);
  // `safe` is already realpath-canonicalized; canonicalize the root too so the
  // "segments below root" scoping in isWorkspaceIgnoredPath actually matches.
  // Without this, a non-canonical root (8.3 short name like ADMINI~1, or a
  // symlink/junction) breaks the prefix match, the segment/sensitive checks
  // fall back to whole-path inspection, and a legitimate workspace that merely
  // lives under AppData/Temp has every read wrongly blocked.
  const canonicalRoot = canonicalizePath(trustedRoot);
  if (isWorkspaceIgnoredPath(safe, canonicalRoot)) {
    throw new Error(`Workspace ignored or sensitive path blocked by policy: ${candidatePath}`);
  }
  return safe;
}

/**
 * 断言路径在可信根「之内」且非敏感,返回规范化后的安全绝对路径;越界/敏感即抛错。
 * 这是读取类工具的核心闸门(写入新文件用 assertTrustedPathForCreate)。
 * @param {string} candidatePath @param {string} trustedRoot @returns {string}
 */
export function assertTrustedPath(candidatePath, trustedRoot) {
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
// Create-aware variant for WRITE targets that may not exist yet. The plain
// assertTrustedPath() canonicalizes the candidate, but realpath() of a
// non-existent path returns the path unresolved — so `root/<junction-to-outside>/
// new.txt` slipped through (the file doesn't exist, the junction isn't resolved).
// Here we walk up to the nearest EXISTING ancestor and canonicalize THAT,
// resolving any junction/symlink, then require the real parent to live inside the
// real root. Returns the safe absolute path (real parent + missing segments).
/** @param {string} candidatePath @param {string} trustedRoot @returns {string} */
export function assertTrustedPathForCreate(candidatePath, trustedRoot) {
  const candidate = resolveWithinRoot(candidatePath, trustedRoot);
  const rootReal = canonicalizePath(trustedRoot);

  let cur = candidate;
  const missing = /** @type {string[]} */ ([]);
  let guard = 0;
  while (!fs.existsSync(cur) && guard < 4096) {
    missing.unshift(path.basename(cur));
    const next = path.dirname(cur);
    if (next === cur) break;
    cur = next;
    guard += 1;
  }
  const parentReal = canonicalizePath(cur);

  const normRoot = normalizeForCompare(rootReal);
  const normParent = normalizeForCompare(parentReal);
  const rootWithSep = normRoot.endsWith('/') ? normRoot : `${normRoot}/`;
  const inside = normParent === normRoot || normParent.startsWith(rootWithSep);
  if (!inside) {
    throw new Error(`Path escaped trusted root: ${candidatePath}`);
  }

  const finalPath = missing.length ? path.join(parentReal, ...missing) : parentReal;
  if (isSensitivePath(finalPath, rootReal)) {
    throw new Error(`Sensitive path blocked by policy: ${candidatePath}`);
  }
  return finalPath;
}

/** assertTrustedPath 的「布尔版」:可信且非敏感返回 true,否则 false(不抛错)。 @param {string} candidatePath @param {string} trustedRoot @returns {boolean} */
export function isTrustedPath(candidatePath, trustedRoot) {
  try {
    assertTrustedPath(candidatePath, trustedRoot);
    return true;
  } catch {
    return false;
  }
}
