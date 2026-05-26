// @ts-check

import fs from 'node:fs';
import path from 'node:path';

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

const SENSITIVE_EXTENSIONS = new Set(['.pem', '.key', '.p12', '.pfx']);
const WORKSPACE_IGNORED_SEGMENTS = new Set(['node_modules', 'dist', 'build', 'coverage']);

/** @returns {boolean} */
function isWindows() {
  return process.platform === 'win32';
}

/** @param {string} p @returns {string} */
function normalizeForCompare(p) {
  const replaced = path.resolve(p).replace(/[\\]/g, '/');
  return isWindows() ? replaced.toLowerCase() : replaced;
}

/** @param {string} p @returns {string} */
function realpath(p) {
  return fs.realpathSync.native ? fs.realpathSync.native(p) : fs.realpathSync(p);
}

/** @param {string} input @returns {string} */
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

/** @param {string} inputPath @param {string | null} [relativeTo] @returns {string[]} */
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

/** @param {string} candidatePath @param {string} trustedRoot @returns {string} */
export function resolveWithinRoot(candidatePath, trustedRoot) {
  return path.isAbsolute(candidatePath)
    ? path.resolve(candidatePath)
    : path.resolve(trustedRoot, candidatePath);
}

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

/** @param {string} inputPath @param {string | null} [relativeTo] @returns {boolean} */
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

/** @param {string} candidatePath @param {string} trustedRoot @returns {string} */
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

/** @param {string} candidatePath @param {string} trustedRoot @returns {string} */
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

/** @param {string} candidatePath @param {string} trustedRoot @returns {boolean} */
export function isTrustedPath(candidatePath, trustedRoot) {
  try {
    assertTrustedPath(candidatePath, trustedRoot);
    return true;
  } catch {
    return false;
  }
}
