// Release output path boundary (scripts · local filesystem safety)
// ---------------------------------------------------------------------------
// Resolves a child below an existing trusted directory and rejects linked or
// escaping existing path components. It does not create, remove, or write.

import fs from 'node:fs';
import path from 'node:path';

function errorCode(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code || '')
    : null;
}

function lstatIfPresent(filePath: string): fs.Stats | null {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  }
}

function comparable(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isOutside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '..'
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative);
}

/**
 * Return a jailed path after validating every existing component from the
 * candidate back to the base. Missing leaf components are allowed only when
 * `mustExist` is false.
 */
export function resolveJailedOutputPath(
  base: string,
  candidate: string,
  label: string,
  mustExist = true,
): string {
  const resolvedBase = path.resolve(base);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedBase, resolvedCandidate);
  if (!relative || isOutside(resolvedCandidate, resolvedBase)) {
    throw new Error(`${label} must stay inside ${resolvedBase}: ${resolvedCandidate}`);
  }

  const baseStat = lstatIfPresent(resolvedBase);
  if (!baseStat || !baseStat.isDirectory()) {
    throw new Error(`${label} base directory does not exist: ${resolvedBase}`);
  }
  if (baseStat.isSymbolicLink()) {
    throw new Error(`${label} base must not be a symbolic link, junction, or reparse point: ${resolvedBase}`);
  }
  const realBase = fs.realpathSync(resolvedBase);
  let current = resolvedCandidate;
  let candidateExists = false;

  while (true) {
    const stat = lstatIfPresent(current);
    if (stat) {
      if (comparable(current) === comparable(resolvedCandidate)) candidateExists = true;
      if (stat.isSymbolicLink()) {
        throw new Error(`${label} must not traverse a symbolic link, junction, or reparse point: ${current}`);
      }
      const realCurrent = fs.realpathSync(current);
      if (isOutside(realCurrent, realBase)) {
        throw new Error(`${label} resolves outside ${realBase}: ${resolvedCandidate}`);
      }
    }
    if (comparable(current) === comparable(resolvedBase)) break;
    const parent = path.dirname(current);
    if (comparable(parent) === comparable(current)) {
      throw new Error(`${label} parent chain does not reach ${resolvedBase}: ${resolvedCandidate}`);
    }
    current = parent;
  }

  if (mustExist && !candidateExists) {
    throw new Error(`${label} does not exist: ${resolvedCandidate}`);
  }
  return resolvedCandidate;
}
