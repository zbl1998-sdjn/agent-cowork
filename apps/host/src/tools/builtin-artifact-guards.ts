// Builtin tool 的 artifact owner 适配(host · L1 领域层 · tools)
import { createArtifactAccessGuards } from '../artifacts/artifact-access-guards.js';
import { contextRecord } from './builtin-tool-options.js';

export function builtinArtifactGuards(rawContext: unknown) {
  const ctx = contextRecord(rawContext);
  const access = ctx.trustedRoot
    ? createArtifactAccessGuards(ctx.trustedRoot, ctx.context)
    : null;
  return {
    ctx,
    inspect(input: unknown): void {
      access?.readPath(input);
    },
    include(fullPath: string): boolean {
      return access?.includeEntry(fullPath, 'file') ?? true;
    },
    inspectFiles(files: unknown): void {
      access?.inspectFiles(files);
    },
  };
}
