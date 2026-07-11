import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type BenchmarkWorkspace = {
  base: string;
  root: string;
};

const workspacePrefix = 'kcw-bench-v2-';

export function createBenchmarkWorkspace(baseInput = os.tmpdir()): BenchmarkWorkspace {
  const base = path.resolve(baseInput);
  fs.mkdirSync(base, { recursive: true });
  const realBase = fs.realpathSync(base);
  const root = fs.mkdtempSync(path.join(realBase, workspacePrefix));
  return { base: realBase, root };
}

export function removeBenchmarkWorkspace(workspace: BenchmarkWorkspace): void {
  const base = path.resolve(workspace.base);
  const root = path.resolve(workspace.root);
  if (path.dirname(root) !== base || !path.basename(root).startsWith(workspacePrefix)) {
    throw new Error(`Refusing benchmark workspace cleanup outside a generated child: ${root}`);
  }
  if (!fs.existsSync(root)) return;
  const stat = fs.lstatSync(root);
  if (stat.isSymbolicLink()) {
    throw new Error(`Refusing benchmark workspace cleanup through a symbolic link: ${root}`);
  }
  const realBase = fs.realpathSync(base);
  const realRoot = fs.realpathSync(root);
  if (path.dirname(realRoot) !== realBase) {
    throw new Error(`Refusing benchmark workspace cleanup outside ${realBase}: ${realRoot}`);
  }
  fs.rmSync(root, { recursive: true, force: false });
}
