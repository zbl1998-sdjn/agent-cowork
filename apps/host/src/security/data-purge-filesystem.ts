// Fail-closed filesystem traversal for data purge (host · L1 security).
// This module owns canonical jail checks, non-following inspection, identity
// revalidation, byte traversal, and deletion. Scope/plan policy stays in data-purge.
import fs from 'node:fs';
import path from 'node:path';
import {
  createManagedDirectoryBoundary,
  type ManagedDirectoryBoundary,
  type ManagedPathInspection,
} from './managed-directory-boundary.js';

export const APP_DIR = '.AgentCowork';

export type PurgeBoundary = Readonly<{
  trustedRoot: string;
  appDir: string;
  filesystem: ManagedDirectoryBoundary;
  guardMutation: (candidatePath: string) => void;
  initialAppDir: ManagedPathInspection | null;
}>;

export type InspectedPurgePath = Readonly<{
  canonicalPath: string;
  stats: fs.Stats;
  managed: ManagedPathInspection;
}>;

function isInsideJail(targetPath: string, jail: string): boolean {
  const relative = path.relative(path.resolve(jail), path.resolve(targetPath));
  return relative === ''
    || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export function samePurgePath(left: string, right: string): boolean {
  return path.relative(path.resolve(left), path.resolve(right)) === '';
}

export function createPurgeBoundary(trustedRoot: string): PurgeBoundary {
  const requestedRoot = String(trustedRoot || '').trim();
  if (!requestedRoot) throw new Error('data-purge: trustedRoot is required');
  const filesystem = createManagedDirectoryBoundary(path.resolve(requestedRoot), {
    create: false,
    label: 'data-purge trusted root',
  });
  const root = filesystem.rootPath;
  const appDir = path.join(root, APP_DIR);
  const initialAppDir = filesystem.inspectPath(appDir, {
    allowMissing: true,
    kind: 'directory',
  });
  const guardMutation = filesystem.createMutationGuard();
  guardMutation(appDir);
  return {
    trustedRoot: root,
    appDir,
    filesystem,
    guardMutation,
    initialAppDir,
  };
}

function inspectStableAppDirectory(boundary: PurgeBoundary): ManagedPathInspection | null {
  boundary.guardMutation(boundary.appDir);
  const current = boundary.filesystem.inspectPath(boundary.appDir, {
    allowMissing: true,
    kind: 'directory',
  });
  if (!boundary.initialAppDir) {
    if (current) throw new Error('data-purge: app directory changed during operation');
    return null;
  }
  if (!current || !samePurgePath(current.canonicalPath, boundary.initialAppDir.canonicalPath)
    || !sameIdentity(current.stats, boundary.initialAppDir.stats)) {
    throw new Error('data-purge: app directory changed during operation');
  }
  return current;
}

export function inspectPurgePath(
  candidatePath: string,
  boundary: PurgeBoundary,
  { allowMissing = false }: { allowMissing?: boolean } = {},
): InspectedPurgePath | null {
  const resolvedCandidate = path.resolve(candidatePath);
  if (!isInsideJail(resolvedCandidate, boundary.appDir)) {
    throw new Error(`data-purge: path escaped jail (${candidatePath})`);
  }
  const stableAppDir = inspectStableAppDirectory(boundary);
  if (!stableAppDir) {
    if (allowMissing) return null;
    throw new Error('data-purge: app directory is unavailable');
  }
  boundary.guardMutation(resolvedCandidate);
  const managed = boundary.filesystem.inspectPath(resolvedCandidate, {
    allowMissing,
    kind: 'either',
  });
  if (!managed) return null;
  if (!isInsideJail(managed.canonicalPath, stableAppDir.canonicalPath)) {
    throw new Error(`data-purge: path escaped jail (${candidatePath})`);
  }
  return {
    canonicalPath: managed.canonicalPath,
    stats: managed.stats,
    managed,
  };
}

function sameIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
    && left.isDirectory() === right.isDirectory() && left.isFile() === right.isFile();
}

export function revalidatePurgePath(
  candidatePath: string,
  boundary: PurgeBoundary,
  previous: InspectedPurgePath,
): InspectedPurgePath {
  const current = inspectPurgePath(candidatePath, boundary);
  if (!current || !samePurgePath(current.canonicalPath, previous.canonicalPath)
    || !sameIdentity(current.stats, previous.stats)) {
    throw new Error(`data-purge: path changed during operation (${candidatePath})`);
  }
  return current;
}

export function listPurgeDirectory(
  candidatePath: string,
  boundary: PurgeBoundary,
  inspected: InspectedPurgePath,
): string[] {
  if (!inspected.stats.isDirectory()) throw new Error(`data-purge: expected directory (${candidatePath})`);
  boundary.guardMutation(candidatePath);
  const names = fs.readdirSync(inspected.canonicalPath);
  revalidatePurgePath(candidatePath, boundary, inspected);
  return names;
}

export function purgePathBytes(target: string, boundary: PurgeBoundary): number {
  let total = 0;
  const stack = [target];
  while (stack.length) {
    const currentPath = stack.pop() as string;
    const inspected = inspectPurgePath(currentPath, boundary);
    if (!inspected) throw new Error(`data-purge: path disappeared during inspection (${currentPath})`);
    if (inspected.stats.isDirectory()) {
      for (const name of listPurgeDirectory(currentPath, boundary, inspected)) {
        stack.push(path.join(currentPath, name));
      }
    } else {
      total += inspected.stats.size;
    }
  }
  return total;
}

export function removePurgeTree(target: string, boundary: PurgeBoundary): boolean {
  const inspected = inspectPurgePath(target, boundary, { allowMissing: true });
  if (!inspected) return false;
  if (inspected.stats.isDirectory()) {
    for (const name of listPurgeDirectory(target, boundary, inspected)) {
      removePurgeTree(path.join(target, name), boundary);
    }
    const current = revalidatePurgePath(target, boundary, inspected);
    if (!current.stats.isDirectory()) throw new Error(`data-purge: directory changed during operation (${target})`);
    boundary.guardMutation(target);
    fs.rmdirSync(current.canonicalPath);
    if (boundary.filesystem.inspectPath(target, { allowMissing: true, kind: 'either' })) {
      throw new Error(`data-purge: deleted directory was replaced (${target})`);
    }
    return true;
  }
  revalidatePurgePath(target, boundary, inspected);
  boundary.guardMutation(target);
  fs.unlinkSync(inspected.canonicalPath);
  if (boundary.filesystem.inspectPath(target, { allowMissing: true, kind: 'either' })) {
    throw new Error(`data-purge: deleted file was replaced (${target})`);
  }
  return true;
}
