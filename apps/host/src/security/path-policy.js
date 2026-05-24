import fs from 'node:fs';
import path from 'node:path';

const SENSITIVE_SEGMENTS = new Set([
  '.ssh',
  '.env',
  'appdata',
  'credentials',
  '.kimi',
]);

const SENSITIVE_FILENAMES = new Set([
  '.env',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
]);

const SENSITIVE_EXTENSIONS = new Set(['.pem', '.key']);

function isWindows() {
  return process.platform === 'win32';
}

function normalizeForCompare(p) {
  const replaced = path.resolve(p).replace(/[\\]/g, '/');
  return isWindows() ? replaced.toLowerCase() : replaced;
}

function realpath(p) {
  return fs.realpathSync.native ? fs.realpathSync.native(p) : fs.realpathSync(p);
}

export function canonicalizePath(input) {
  const resolved = path.resolve(input);
  try {
    return realpath(resolved);
  } catch {
    // The path (or its leaf) doesn't exist yet, so realpath() fails and would
    // otherwise return the path UNRESOLVED. On Windows that leaves 8.3 short
    // names (e.g. ADMINI~1) and junctions intact in the prefix, so a containment
    // check against a realpath'd root spuriously reports "escaped". Resolve the
    // nearest EXISTING ancestor (canonicalizing the prefix) and re-append the
    // missing tail so not-yet-created paths compare correctly.
    let cur = resolved;
    const missing = [];
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

function splitSegments(p) {
  return normalizeForCompare(p)
    .split('/')
    .filter(Boolean);
}

export function resolveWithinRoot(candidatePath, trustedRoot) {
  return path.isAbsolute(candidatePath)
    ? path.resolve(candidatePath)
    : path.resolve(trustedRoot, candidatePath);
}

// Is this path sensitive (must never be written/read by the agent)?
//
// `relativeTo` (optional): when given, the directory-SEGMENT checks (.ssh,
// appdata, credentials, .env-prefixed dirs, .kimi) only inspect the portion of
// the path BELOW that trusted root. The root prefix is operator/user-chosen and
// therefore trusted — without this, a workspace that merely *lives under* a
// directory like `AppData` would have every write blocked even though the agent
// can never escape the root (assertTrustedPath enforces that separately).
// The filename/extension checks (id_rsa, *.key/*.pem) always apply to the
// target itself, since those describe the file being created regardless of
// where the workspace sits. Called WITHOUT relativeTo, behaviour is unchanged
// (whole-path inspection) for direct callers and back-compat.
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
  let scope = normalized;
  if (relativeTo) {
    const normRoot = normalizeForCompare(relativeTo);
    const rootWithSep = normRoot.endsWith('/') ? normRoot : `${normRoot}/`;
    if (normalized === normRoot) {
      scope = '';
    } else if (normalized.startsWith(rootWithSep)) {
      scope = normalized.slice(rootWithSep.length);
    }
    // If not inside the root, leave scope = full path (defensive; the caller's
    // escape check should already have rejected it).
  }
  const segments = scope.split('/').filter(Boolean);

  for (const segment of segments) {
    // Sensitive directory names (appdata/.ssh/credentials/.kimi) are matched
    // case-INSENSITIVELY. `normalizeForCompare` only lower-cases on Windows, so
    // without this a path containing `AppData` (capital A) would slip past the
    // lowercase `SENSITIVE_SEGMENTS` on a case-sensitive (Linux) host. The
    // containment/escape check elsewhere stays case-sensitive on purpose.
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
export function assertTrustedPathForCreate(candidatePath, trustedRoot) {
  const candidate = resolveWithinRoot(candidatePath, trustedRoot);
  const rootReal = canonicalizePath(trustedRoot);

  let cur = candidate;
  const missing = [];
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

export function isTrustedPath(candidatePath, trustedRoot) {
  try {
    assertTrustedPath(candidatePath, trustedRoot);
    return true;
  } catch {
    return false;
  }
}
