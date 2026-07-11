#!/usr/bin/env node
// 重建 host Node SEA 旁挂二进制 agent-cowork-host.exe(scripts · 构建)
// ---------------------------------------------------------------------------
// 职责:把 apps/host/src 编译→esbuild 打包→生成 SEA blob→复制 node.exe→去签名→
//       postject 注入,产出可独立运行的 host.exe,并部署到 Tauri 的 binaries/ 与
//       target/release/,确保旁挂二进制始终跟随当前源码(仅支持 Windows)。
// 用法:npm run build:host;打包桌面应用前的必跑步骤。
// 依赖:esbuild(复用 ui 子项目)、Windows SDK 的 signtool、postject;host-ts-support.js。
//
// Rebuild the host Node SEA sidecar (`agent-cowork-host.exe`).
//
// History: the host sidecar was a frozen 92MB binary with no reproducible
// build, so it silently drifted from source — Codex shipped /api/projects on
// 2026-05-27 but the bundled host (last built 2026-05-26) didn't have it, and
// the Projects panel returned 404 in the packaged app. This script codifies
// the chain so the sidecar always tracks current source.
//
// Steps (Windows): esbuild → SEA blob → copy node.exe → signtool remove →
// postject inject (with the fuse string read from the actual node.exe — node
// v24 changed the default fuse hex value, so don't hard-code it).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertHostTypeCoverage,
  hostBuildConfigPath,
  runTypeScriptProject,
} from './host-ts-support.js';

type ProcessWithStreams = typeof process & {
  stdout: { write(message: string): unknown };
  stderr: { write(message: string): unknown };
};

type SearchableBuffer = Buffer & {
  indexOf(value: Buffer | string): number;
  toString(encoding?: string, start?: number, end?: number): string;
};

type SpawnOptions = Record<string, unknown>;

const processWithStreams = process as ProcessWithStreams;

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const hostDir = path.join(repoRoot, 'apps', 'host');
const distDir = path.join(hostDir, 'dist');
const compiledHostDir = path.join(repoRoot, 'build', 'host-src');
const tauriDir = path.join(repoRoot, 'apps', 'windows-client', 'src-tauri');
const binariesDir = path.join(tauriDir, 'binaries');
const targetReleaseDir = path.join(tauriDir, 'target', 'release');

function log(msg: string): void {
  processWithStreams.stdout.write(`[build-host] ${msg}\n`);
}

function die(msg: string): never {
  processWithStreams.stderr.write(`[build-host] ERROR: ${msg}\n`);
  process.exit(1);
}

function run(cmd: string, args: readonly string[], options: SpawnOptions = {}): void {
  log(`$ ${cmd} ${args.join(' ')}`);
  const result = spawnSync(cmd, args, { stdio: 'inherit', shell: false, ...options });
  if (result.status !== 0) die(`command failed (exit ${result.status}): ${cmd}`);
}

function cleanCompiledHostDir(): void {
  const relative = path.relative(path.join(repoRoot, 'build'), compiledHostDir);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    die(`refusing to clean outside build/: ${compiledHostDir}`);
  }
  fs.rmSync(compiledHostDir, { recursive: true, force: true });
  fs.mkdirSync(compiledHostDir, { recursive: true });
}

function findEsbuild(): string {
  // The repo doesn't install esbuild at the root; reuse the one Vite pulls in.
  const candidates = [
    path.join(repoRoot, 'node_modules', 'esbuild', 'bin', 'esbuild'),
    path.join(repoRoot, 'apps', 'windows-client', 'ui', 'node_modules', 'esbuild', 'bin', 'esbuild'),
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) die('esbuild not found. Run `npm --prefix apps/windows-client/ui install` first.');
  return found;
}

function findSigntoolWindows(): string | null {
  // signtool is needed on Windows to strip the Authenticode signature from the
  // copied node.exe; postject can't find the SEA fuse sentinel through the
  // signature's overlay otherwise.
  const kitsRoot = 'C:\\Program Files (x86)\\Windows Kits\\10\\bin';
  if (!fs.existsSync(kitsRoot)) return null;
  const versions = fs.readdirSync(kitsRoot)
    .filter((entry) => /^10\./.test(entry))
    .sort()
    .reverse();
  for (const version of versions) {
    const candidate = path.join(kitsRoot, version, 'x64', 'signtool.exe');
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function extractFuse(exePath: string): string {
  // Node's SEA fuse hex changes across versions (v24 ≠ the legacy fce680ab…7e0e6
  // value postject hard-codes in its examples). Read the actual sentinel out of
  // the copied node.exe and pass it through to postject.
  const buffer = fs.readFileSync(exePath) as SearchableBuffer;
  const marker = Buffer.from('NODE_SEA_FUSE_');
  const index = buffer.indexOf(marker);
  if (index < 0) die(`SEA fuse sentinel not found in ${exePath}`);
  const fuse = buffer.toString('ascii', index, index + 14 + 32);
  if (!/^NODE_SEA_FUSE_[0-9a-fA-F]{32}$/.test(fuse)) die(`malformed SEA fuse: ${fuse}`);
  return fuse;
}

if (process.platform !== 'win32') {
  die('Only Windows is supported today (the SEA wrapper is .exe). Extend this script when other platforms ship.');
}

const esbuild = findEsbuild();
const postjectCli = path.join(repoRoot, 'node_modules', 'postject', 'dist', 'cli.js');
if (!fs.existsSync(postjectCli)) die('postject not found. Run `npm ci` before building the host.');
const signtool = findSigntoolWindows();
if (!signtool) die('signtool.exe not found in Windows Kits — install Windows 10 SDK.');

fs.mkdirSync(distDir, { recursive: true });
const bundlePath = path.join(distDir, 'host-bundle.cjs');
const blobPath = path.join(distDir, 'host.blob');
const exePath = path.join(distDir, 'agent-cowork-host.exe');

log('1/6 tsc — compiling apps/host/src → build/host-src');
assertHostTypeCoverage();
cleanCompiledHostDir();
const tscStatus = runTypeScriptProject(hostBuildConfigPath, repoRoot);
if (tscStatus !== 0) die(`TypeScript host compile failed (exit ${tscStatus})`);

log('2/6 esbuild — bundling build/host-src/main.js → dist/host-bundle.cjs');
run(process.execPath, [
  esbuild,
  path.join('build', 'host-src', 'main.js'),
  '--bundle',
  '--platform=node',
  '--format=cjs',
  `--outfile=${path.relative(repoRoot, bundlePath)}`,
  '--target=node22',
  // The bundle keeps `createRequire(import.meta.url)` and `fileURLToPath(import.meta.url)`
  // calls; under SEA there is no import.meta, so define a valid file URL here.
  '--define:import.meta.url="file:///C:/host-bundle.cjs"',
], { cwd: repoRoot });

log('3/6 node --experimental-sea-config → dist/host.blob');
run(process.execPath, ['--experimental-sea-config', 'sea-config.json'], { cwd: hostDir });

log(`4/6 copy ${process.execPath} → ${path.relative(repoRoot, exePath)}`);
fs.copyFileSync(process.execPath, exePath);

log('5/6 strip signature + postject inject NODE_SEA_BLOB');
run(signtool, ['remove', '/s', exePath]);
const fuse = extractFuse(exePath);
log(`    fuse: ${fuse}`);
// Use the lockfile-installed CLI through Node directly. shell:false preserves paths
// containing spaces and prevents npx from downloading a drifting build dependency.
run(process.execPath, [postjectCli, exePath, 'NODE_SEA_BLOB', blobPath, '--sentinel-fuse', fuse], { cwd: repoRoot });

log('6/6 deploy to binaries/ and target/release/');
fs.mkdirSync(binariesDir, { recursive: true });
const binaryDest = path.join(binariesDir, 'agent-cowork-host-x86_64-pc-windows-msvc.exe');
fs.copyFileSync(exePath, binaryDest);
log(`    -> ${path.relative(repoRoot, binaryDest)}`);
if (fs.existsSync(targetReleaseDir)) {
  const releaseDest = path.join(targetReleaseDir, 'agent-cowork-host.exe');
  fs.copyFileSync(exePath, releaseDest);
  log(`    -> ${path.relative(repoRoot, releaseDest)} (runtime sidecar)`);
} else {
  log('    target/release/ does not exist yet — run `cargo tauri build` next.');
}

log('done. Verify with:');
log("  $env:PORT='3998'; & apps\\host\\dist\\agent-cowork-host.exe");
log("  Invoke-WebRequest http://127.0.0.1:3998/health");
