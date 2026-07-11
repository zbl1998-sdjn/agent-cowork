// Recipe 来源文件 owner 预检(host · L1 领域层 · recipes)
import { createArtifactAccessGuards } from '../artifacts/artifact-access-guards.js';

export function filePathFromRecipeRequest(item: unknown): string {
  const record = item && typeof item === 'object'
    ? item as { fullPath?: unknown; path?: unknown }
    : {};
  if (typeof item === 'string') return item;
  if (typeof record.fullPath === 'string') return record.fullPath;
  return typeof record.path === 'string' ? record.path : '';
}

export function preflightRecipeSourceFiles({
  trustedRoot,
  files,
  owner,
}: {
  trustedRoot: string;
  files: unknown;
  owner: unknown;
}): unknown[] {
  const requested = Array.isArray(files) ? files.slice(0, 12) : [];
  const access = createArtifactAccessGuards(trustedRoot, owner);
  for (const item of requested) {
    const filePath = filePathFromRecipeRequest(item);
    if (filePath) access.readPath(filePath);
  }
  return requested;
}
