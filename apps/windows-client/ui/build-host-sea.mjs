// Bundle the Node host (ESM, multi-file) into a single CJS file suitable for a
// Node SEA (single executable). Run from this ui dir so esbuild resolves from
// node_modules. The `import.meta.url` define fixes esbuild's CJS interop shim
// (createRequire(import.meta.url)) which is undefined inside a SEA.
import * as esbuild from 'esbuild';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// ui is apps/windows-client/ui; host is apps/host -> go up 2 then into host
const realHostRoot = path.resolve(here, '..', '..', 'host');
const repoRoot = path.resolve(here, '..', '..', '..');
const compile = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'build-host-source.mjs')], {
  cwd: repoRoot,
  stdio: 'inherit',
});
if (compile.status !== 0) process.exit(compile.status ?? 1);

await esbuild.build({
  entryPoints: [path.join(repoRoot, 'build', 'host-src', 'main.js')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: path.join(realHostRoot, 'dist/host-bundle.cjs'),
  define: { 'import.meta.url': JSON.stringify('file:///C:/kimi-host-sea.cjs') },
  logLevel: 'warning',
});
console.log('host bundle rebuilt (import.meta.url defined) ->', path.join(realHostRoot, 'dist/host-bundle.cjs'));
