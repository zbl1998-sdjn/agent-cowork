#!/usr/bin/env node
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

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const hostDir = path.join(repoRoot, 'apps', 'host');
const distDir = path.join(hostDir, 'dist');
const tauriDir = path.join(repoRoot, 'apps', 'windows-client', 'src-tauri');
const binariesDir = path.join(tauriDir, 'binaries');
const targetReleaseDir = path.join(tauriDir, 'target', 'release');

function log(msg) { process.stdout.write(`[build-host] ${msg}\n`); }
function die(msg) { process.stderr.write(`[build-host] ERROR: ${msg}\n`); process.exit(1); }

function run(cmd, args, options = {}) {
  log(`$ ${cmd} ${args.join(' ')}`);
  const result = spawnSync(cmd, args, { stdio: 'inherit', shell: false, ...options });
  if (result.status !== 0) die(`command failed (exit ${result.status}): ${cmd}`);
}

function runCapture(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false, ...options });
  if (result.status !== 0) die(`command failed (exit ${result.status}): ${cmd}\n${result.stderr?.toString() || ''}`);
  return result.stdout?.toString() || '';
}

function findEsbuild() {
  // The repo doesn't install esbuild at the root; reuse the one Vite pulls in.
  const candidates = [
    path.join(repoRoot, 'node_modules', 'esbuild', 'bin', 'esbuild'),
    path.join(repoRoot, 'apps', 'windows-client', 'ui', 'node_modules', 'esbuild', 'bin', 'esbuild'),
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) die('esbuild not found. Run `npm --prefix apps/windows-client/ui install` first.');
  return found;
}

function findSigntoolWindows() {
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

function extractFuse(exePath) {
  // Node's SEA fuse hex changes across versions (v24 ≠ the legacy fce680ab…7e0e6
  // value postject hard-codes in its examples). Read the actual sentinel out of
  // the copied node.exe and pass it through to postject.
  const buffer = fs.readFileSync(exePath);
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
const signtool = findSigntoolWindows();
if (!signtool) die('signtool.exe not found in Windows Kits — install Windows 10 SDK.');

fs.mkdirSync(distDir, { recursive: true });
const bundlePath = path.join(distDir, 'host-bundle.cjs');
const blobPath = path.join(distDir, 'host.blob');
const exePath = path.join(distDir, 'agent-cowork-host.exe');

log('1/5 esbuild — bundling apps/host/src/main.js → dist/host-bundle.cjs');
run(process.execPath, [
  esbuild,
  path.join('apps', 'host', 'src', 'main.js'),
  '--bundle',
  '--platform=node',
  '--format=cjs',
  `--outfile=${path.relative(repoRoot, bundlePath)}`,
  '--external:pg', // optional postgres backend; loaded via dynamic import at runtime
  '--target=node22',
  // The bundle keeps `createRequire(import.meta.url)` and `fileURLToPath(import.meta.url)`
  // calls; under SEA there is no import.meta, so define a valid file URL here.
  '--define:import.meta.url="file:///C:/host-bundle.cjs"',
], { cwd: repoRoot });

log('2/5 node --experimental-sea-config → dist/host.blob');
run(process.execPath, ['--experimental-sea-config', 'sea-config.json'], { cwd: hostDir });

log(`3/5 copy ${process.execPath} → ${path.relative(repoRoot, exePath)}`);
fs.copyFileSync(process.execPath, exePath);

log('4/5 strip signature + postject inject NODE_SEA_BLOB');
run(signtool, ['remove', '/s', exePath]);
const fuse = extractFuse(exePath);
log(`    fuse: ${fuse}`);
// With `shell: true` on Windows, child_process re-tokenises args via cmd.exe and
// strips internal whitespace — so a path like `C:\Users\…\agent cowork\…\.exe`
// splits at the space and postject sees "agent" + "cowork\…\.exe" as separate
// resources, surfacing as "Can't read resource file". Manually double-quote any
// arg with whitespace so cmd.exe leaves it intact.
const quoteForShell = (arg) => (/\s/.test(arg) ? `"${arg}"` : arg);
run('npx', ['-y', 'postject', quoteForShell(exePath), 'NODE_SEA_BLOB', quoteForShell(blobPath), '--sentinel-fuse', fuse], { cwd: repoRoot, shell: true });

log('5/5 deploy to binaries/ and target/release/');
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
