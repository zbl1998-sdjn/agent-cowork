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

export function canonicalizePath(input) {
  const resolved = path.resolve(input);
  try {
    return fs.realpathSync.native ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved);
  } catch {
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

export function isSensitivePath(inputPath) {
  const normalized = normalizeForCompare(inputPath);
  const segments = splitSegments(normalized);
  const lowerBase = path.basename(normalized).toLowerCase();
  const lowerExt = path.extname(lowerBase).toLowerCase();
  const hasExplicitKimiRoot = normalized.includes('/.kimi/');

  if (lowerBase === 'id_rsa' || lowerBase.startsWith('id_rsa')) {
    return true;
  }

  if (SENSITIVE_EXTENSIONS.has(lowerExt)) {
    return true;
  }

  for (const segment of segments) {
    if (SENSITIVE_SEGMENTS.has(segment)) {
      return true;
    }
    if (segment === '.env' || segment.startsWith('.env')) {
      return true;
    }
  }

  if (hasExplicitKimiRoot && segments.includes('credentials')) {
    return true;
  }

  if (SENSITIVE_FILENAMES.has(lowerBase)) {
    return true;
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

  if (isSensitivePath(absoluteCandidate)) {
    throw new Error(`Sensitive path blocked by policy: ${candidatePath}`);
  }

  return absoluteCandidate;
}

export function isTrustedPath(candidatePath, trustedRoot) {
  try {
    assertTrustedPath(candidatePath, trustedRoot);
    return true;
  } catch {
    return false;
  }
}
