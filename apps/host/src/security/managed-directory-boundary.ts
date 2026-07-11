// Stable managed-directory boundary (host · L0 security).
// Captures a non-link directory's canonical path and identity, then rechecks
// both around every file operation so runtime junction swaps fail closed.
import fs from 'node:fs';
import path from 'node:path';
import { canonicalizePath } from './path-policy.js';

export type ManagedPathKind = 'file' | 'directory' | 'either';
export type ManagedPathInspection = Readonly<{
  canonicalPath: string;
  stats: fs.Stats;
  ancestors: readonly ManagedAncestorInspection[];
}>;
type ManagedAncestorInspection = Readonly<{
  path: string;
  canonicalPath: string;
  stats: fs.Stats;
}>;
export type ManagedPathOptions = Readonly<{
  allowMissing?: boolean;
  kind?: ManagedPathKind;
}>;
export type ManagedDirectoryBoundary = Readonly<{
  rootPath: string;
  canonicalRoot: string;
  createMutationGuard(): (candidatePath: string) => void;
  inspectPath(candidatePath: string, options?: ManagedPathOptions): ManagedPathInspection | null;
  revalidatePath(
    candidatePath: string,
    previous: ManagedPathInspection,
    options?: Omit<ManagedPathOptions, 'allowMissing'>,
  ): ManagedPathInspection;
}>;

type BoundaryOptions = Readonly<{ create?: boolean; label?: string }>;

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null
    && (error as { code?: unknown }).code === code;
}

function isInside(candidatePath: string, rootPath: string): boolean {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return relative === ''
    || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function samePath(left: string, right: string): boolean {
  return path.relative(path.resolve(left), path.resolve(right)) === '';
}

function sameRootIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
    && left.isDirectory() === right.isDirectory();
}

function sameEntryIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return sameRootIdentity(left, right)
    && left.isFile() === right.isFile()
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs;
}

function sameAncestorIdentity(left: ManagedAncestorInspection, right: ManagedAncestorInspection): boolean {
  return samePath(left.path, right.path)
    && samePath(left.canonicalPath, right.canonicalPath)
    && sameRootIdentity(left.stats, right.stats);
}

function sameAncestorChain(
  left: readonly ManagedAncestorInspection[],
  right: readonly ManagedAncestorInspection[],
): boolean {
  return left.length === right.length
    && left.every((entry, index) => {
      const candidate = right[index];
      return Boolean(candidate && sameAncestorIdentity(entry, candidate));
    });
}

function requireKind(stats: fs.Stats, kind: ManagedPathKind, label: string): void {
  if (kind === 'file' && !stats.isFile()) throw new Error(`${label}: expected a regular file`);
  if (kind === 'directory' && !stats.isDirectory()) throw new Error(`${label}: expected a directory`);
  if (kind === 'either' && !stats.isFile() && !stats.isDirectory()) {
    throw new Error(`${label}: unsupported filesystem entry`);
  }
}

export function createManagedDirectoryBoundary(
  rootInput: string,
  { create = true, label = 'managed directory' }: BoundaryOptions = {},
): ManagedDirectoryBoundary {
  const rootPath = path.resolve(rootInput);
  if (create) fs.mkdirSync(rootPath, { recursive: true });
  const initialStats = fs.lstatSync(rootPath);
  if (initialStats.isSymbolicLink()) {
    throw new Error(`${label}: symbolic link, junction, or reparse point is not allowed`);
  }
  if (!initialStats.isDirectory()) throw new Error(`${label}: expected a directory`);
  const canonicalRoot = canonicalizePath(rootPath);

  function inspectRoot(allowMissing: boolean): fs.Stats | null {
    let current: fs.Stats;
    try {
      current = fs.lstatSync(rootPath);
    } catch (error) {
      if (allowMissing && isErrorCode(error, 'ENOENT')) return null;
      throw error;
    }
    if (current.isSymbolicLink()) {
      throw new Error(`${label}: symbolic link, junction, or reparse point is not allowed`);
    }
    if (!current.isDirectory()) throw new Error(`${label}: expected a directory`);
    if (!samePath(canonicalizePath(rootPath), canonicalRoot)
      || !sameRootIdentity(current, initialStats)) {
      throw new Error(`${label}: managed directory changed during operation`);
    }
    return current;
  }

  function inspectPath(
    candidateInput: string,
    { allowMissing = false, kind = 'either' }: ManagedPathOptions = {},
  ): ManagedPathInspection | null {
    const candidatePath = path.resolve(candidateInput);
    if (!isInside(candidatePath, rootPath)) throw new Error(`${label}: path escaped managed directory`);
    const rootStats = inspectRoot(allowMissing);
    if (!rootStats) return null;
    if (samePath(candidatePath, rootPath)) {
      requireKind(rootStats, kind, label);
      return { canonicalPath: canonicalRoot, stats: rootStats, ancestors: [] };
    }

    const relative = path.relative(rootPath, candidatePath);
    const segments = relative.split(path.sep).filter(Boolean);
    const inspected: ManagedAncestorInspection[] = [];
    let currentPath = rootPath;
    for (const [index, segment] of segments.entries()) {
      currentPath = path.join(currentPath, segment);
      let currentStats: fs.Stats;
      try {
        currentStats = fs.lstatSync(currentPath);
      } catch (error) {
        if (allowMissing && isErrorCode(error, 'ENOENT')) break;
        throw error;
      }
      if (currentStats.isSymbolicLink()) {
        throw new Error(`${label}: symbolic link, junction, or reparse point is not allowed`);
      }
      if (index < segments.length - 1 && !currentStats.isDirectory()) {
        throw new Error(`${label}: path parent must be a directory`);
      }
      const canonicalPath = canonicalizePath(currentPath);
      if (!isInside(canonicalPath, canonicalRoot)) {
        throw new Error(`${label}: path escaped managed directory`);
      }
      inspected.push({ path: currentPath, canonicalPath, stats: currentStats });
    }

    const candidate = inspected.at(-1);
    if (!candidate || !samePath(candidate.path, candidatePath)) {
      inspectRoot(false);
      if (allowMissing) return null;
      fs.lstatSync(candidatePath);
      throw new Error(`${label}: managed path is unavailable`);
    }
    requireKind(candidate.stats, kind, label);
    const ancestors = inspected.slice(0, -1);
    for (const ancestor of ancestors) {
      const current = fs.lstatSync(ancestor.path);
      if (current.isSymbolicLink()
        || !samePath(canonicalizePath(ancestor.path), ancestor.canonicalPath)
        || !sameRootIdentity(current, ancestor.stats)) {
        throw new Error(`${label}: managed path parent changed during operation`);
      }
    }
    inspectRoot(false);
    return { canonicalPath: candidate.canonicalPath, stats: candidate.stats, ancestors };
  }

  function revalidatePath(
    candidatePath: string,
    previous: ManagedPathInspection,
    options: Omit<ManagedPathOptions, 'allowMissing'> = {},
  ): ManagedPathInspection {
    const current = inspectPath(candidatePath, { ...options, allowMissing: false });
    if (!current || !samePath(current.canonicalPath, previous.canonicalPath)
      || !sameEntryIdentity(current.stats, previous.stats)
      || !sameAncestorChain(current.ancestors, previous.ancestors)) {
      throw new Error(`${label}: managed path changed during operation`);
    }
    return current;
  }

  function createMutationGuard(): (candidateInput: string) => void {
    const pinnedDirectories: ManagedAncestorInspection[] = [];
    return (candidateInput: string): void => {
      const candidatePath = path.resolve(candidateInput);
      if (!isInside(candidatePath, rootPath)) throw new Error(`${label}: path escaped managed directory`);
      let probe = candidatePath;
      let currentDirectories: ManagedAncestorInspection[] = [];
      for (;;) {
        const inspection = inspectPath(probe, { allowMissing: true });
        if (inspection) {
          currentDirectories = [...inspection.ancestors];
          if (inspection.stats.isDirectory() && !samePath(probe, rootPath)) {
            currentDirectories.push({
              path: probe,
              canonicalPath: inspection.canonicalPath,
              stats: inspection.stats,
            });
          }
          break;
        }
        const parent = path.dirname(probe);
        if (samePath(parent, probe)) throw new Error(`${label}: managed path is unavailable`);
        probe = parent;
      }
      for (const pinned of pinnedDirectories) {
        if (isInside(candidatePath, pinned.path)
          && !currentDirectories.some((entry) => samePath(entry.path, pinned.path))) {
          throw new Error(`${label}: managed path parent changed during operation`);
        }
      }
      for (const entry of currentDirectories) {
        const pinned = pinnedDirectories.find((candidate) => samePath(candidate.path, entry.path));
        if (pinned && !sameAncestorIdentity(pinned, entry)) {
          throw new Error(`${label}: managed path parent changed during operation`);
        }
        if (!pinned) pinnedDirectories.push(entry);
      }
    };
  }

  return { rootPath, canonicalRoot, createMutationGuard, inspectPath, revalidatePath };
}
