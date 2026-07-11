// 版本发布流水线:跑完整门禁、重建产物、可信签名、归档并打标签(scripts · 构建)
// ---------------------------------------------------------------------------
// 职责:校验所有 manifest 版本与工作区干净度;默认 dry-run 仅打印计划,--execute 时
//   强制完整本地门禁并从当前 HEAD 重建 UI/SEA/Tauri 安装包,用可信证书签名后
//   生成源码 bundle、归档 canonical Tauri 产物与 provenance manifest,最后打 tag。
// 用法:npm run release -- --version <semver> [--execute]
//   (即 node scripts/run-host-node.mjs scripts/release.ts);省略 --execute 为预演。
// 依赖:scripts/quality_gate.py、Tauri/Cargo、git bundle/tag、可信签名配置。

import { spawnSync } from 'node:child_process';
import type { SpawnSyncResult } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildReleaseCommandSpec,
  FULL_SOURCE_GATE_TIMEOUT_MS,
} from './release-command.js';
import {
  assertChangelogVersion,
  assertInstallerVersions,
  assertReleaseVersions,
  cleanCanonicalBundleRoot,
  createArtifactEvidence,
  createReleaseManifest,
  selectUpdaterArtifacts,
} from './release-integrity.js';
import type { ArtifactEvidence, BundleEvidence } from './release-integrity.js';
import { resolveJailedOutputPath } from './release-path-boundary.js';

type PackageJson = {
  name: string;
  version: string;
};

type ReleaseOptions = {
  execute: boolean;
  version: string | null;
};

type RunOptions = {
  execute?: boolean;
  cwd?: string;
  capture?: boolean;
  timeoutMs?: number;
};

type SigningConfig = {
  mode: 'thumbprint' | 'pfx';
  args: string[];
};

type CommandResult = SpawnSyncResult<string | Buffer> | {
  status: number;
  stdout: string;
  stderr: string;
};

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tauriRoot = path.join(repoRoot, 'apps', 'windows-client', 'src-tauri');
const packageJsonPath = path.join(repoRoot, 'package.json');
const packageJson = readPackageJson();
const semverRe = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

process.once('uncaughtException', (error) => {
  console.error(`[release] ${formatErrorMessage(error)}`);
  process.exit(1);
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readPackageJson(): PackageJson {
  const parsed: unknown = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  if (!isRecord(parsed) || typeof parsed.name !== 'string' || typeof parsed.version !== 'string') {
    throw new Error('package.json is missing string name/version fields');
  }
  return { name: parsed.name, version: parsed.version };
}

function readJsonVersion(filePath: string, label: string): string {
  const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!isRecord(parsed) || typeof parsed.version !== 'string') {
    throw new Error(`${label} is missing a string version field`);
  }
  return parsed.version;
}

function readCargoPackageVersion(filePath: string): string {
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  let inPackage = false;
  let version: string | undefined;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\[[^\]]+\]$/.test(trimmed)) {
      if (inPackage) break;
      inPackage = trimmed === '[package]';
      continue;
    }
    if (!inPackage) continue;
    const match = /^version\s*=\s*"([^"]+)"\s*$/.exec(trimmed);
    if (match?.[1]) {
      version = match[1];
      break;
    }
  }
  if (!version) throw new Error('Cargo.toml [package] is missing a version');
  return version;
}

function projectVersions(): Record<string, string> {
  return {
    root: packageJson.version,
    ui: readJsonVersion(path.join(repoRoot, 'apps', 'windows-client', 'ui', 'package.json'), 'UI package.json'),
    cargo: readCargoPackageVersion(path.join(repoRoot, 'apps', 'windows-client', 'src-tauri', 'Cargo.toml')),
    tauri: readJsonVersion(path.join(repoRoot, 'apps', 'windows-client', 'src-tauri', 'tauri.conf.json'), 'tauri.conf.json'),
  };
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requiredArg(value: string | undefined, message: string): string {
  if (value === undefined) throw new Error(message);
  return value;
}

function usage(exitCode = 0): never {
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write(`Usage: npm run release -- --version <semver> [--execute]\n`);
  stream.write(`       npm run release -- <semver> [--execute]\n\n`);
  stream.write(`Default mode is dry-run: it prints the release plan and does not write files, create tags, or build bundles.\n`);
  stream.write(`Use --execute to create releases/v<semver>/VERSION.txt, a git bundle, and an annotated tag.\n`);
  process.exit(exitCode);
}

function parseArgs(argv: string[]): ReleaseOptions {
  const options: ReleaseOptions = {
    execute: false,
    version: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = requiredArg(argv[index], 'Missing release argument');
    if (arg === '--help' || arg === '-h') usage(0);
    if (arg === '--execute') {
      options.execute = true;
    } else if (arg === '--version') {
      options.version = requiredArg(argv[index + 1], 'Missing value after --version');
      index += 1;
    } else if (!arg.startsWith('-') && !options.version) {
      options.version = arg;
    } else {
      throw new Error(`Unknown or duplicate argument: ${arg}`);
    }
  }
  return options;
}

function normalizeVersion(version: string): string {
  if (!version) {
    throw new Error('Missing release version. Pass --version <semver>.');
  }
  const normalized = version.startsWith('v') ? version.slice(1) : version;
  if (!semverRe.test(normalized)) {
    throw new Error(`Invalid SemVer version: ${version}`);
  }
  return normalized;
}

function commandLine(command: string, args: readonly string[]): string {
  return [command, ...args].map((part) => (/\s/.test(part) ? `"${part}"` : part)).join(' ');
}

function firstEnvValue(names: readonly string[]): string | null {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return null;
}

function resolveProductionSigningConfig(): SigningConfig | null {
  const thumbprint = firstEnvValue(['KCW_CODESIGN_THUMBPRINT', 'WINDOWS_SIGNING_THUMBPRINT']);
  if (thumbprint) {
    const normalized = thumbprint.replace(/\s/g, '');
    if (!/^[0-9a-f]{40}$/i.test(normalized)) {
      throw new Error('Windows code-signing thumbprint must contain exactly 40 hexadecimal characters.');
    }
    return { mode: 'thumbprint', args: ['-Thumbprint', normalized] };
  }
  const pfx = firstEnvValue(['KCW_CODESIGN_PFX', 'WINDOWS_SIGNING_PFX']);
  if (pfx) {
    return { mode: 'pfx', args: ['-Pfx', path.isAbsolute(pfx) ? pfx : path.resolve(repoRoot, pfx)] };
  }
  return null;
}

function productionSigningHelp(): string {
  return [
    'Production signing requires a trusted CA code-signing certificate.',
    'Set KCW_CODESIGN_THUMBPRINT (preferred, cert already imported with private key) or',
    'set KCW_CODESIGN_PFX plus KCW_CODESIGN_PFX_PASSWORD/WINDOWS_SIGNING_PFX_PASSWORD.',
    'Refusing to fall back to self-signed signing for release execution.',
  ].join(' ');
}

function run(command: string, args: string[], options: RunOptions = {}): CommandResult {
  const printable = commandLine(command, args);
  if (!options.execute) {
    console.log(`[dry-run] ${printable}`);
    return { status: 0, stdout: '', stderr: '' };
  }
  console.log(`[exec] ${printable}`);
  const spec = buildReleaseCommandSpec(command, args);
  const result = spawnSync(spec.command, spec.args, {
    cwd: options.cwd || repoRoot,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
    windowsHide: true,
    shell: false,
    timeout: options.timeoutMs ?? 1_800_000,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`Command failed (${result.status}): ${printable}`);
  }
  return result;
}

function git(args: string[], options: RunOptions = {}): CommandResult {
  return run('git', ['-c', `safe.directory=${repoRoot.replaceAll('\\', '/')}`, ...args], options);
}

function gitCapture(args: string[]): string {
  const spec = buildReleaseCommandSpec('git', ['-c', `safe.directory=${repoRoot.replaceAll('\\', '/')}`, ...args]);
  const result = spawnSync(spec.command, spec.args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: 'pipe',
    windowsHide: true,
    shell: false,
    timeout: 30_000,
  });
  if (result.error) {
    throw new Error(`Git probe failed: ${formatErrorMessage(result.error)}`);
  }
  if (result.status !== 0) {
    const stderr = typeof result.stderr === 'string'
      ? result.stderr
      : result.stderr?.toString('utf8') ?? '';
    throw new Error(`Git probe exited with status ${String(result.status)}: ${stderr.trim()}`);
  }
  const stdout = typeof result.stdout === 'string' ? result.stdout : result.stdout?.toString('utf8') ?? '';
  return stdout.trim();
}

function readGitHead(): string | null {
  const gitDir = path.join(repoRoot, '.git');
  const headPath = path.join(gitDir, 'HEAD');
  if (!fs.existsSync(headPath)) return null;
  const head = fs.readFileSync(headPath, 'utf8').trim();
  if (/^[0-9a-f]{40}$/i.test(head)) return head;
  const refMatch = /^ref:\s+(.+)$/.exec(head);
  if (!refMatch) return null;
  const refNameFromHead = refMatch[1];
  if (!refNameFromHead) return null;
  const refPath = path.join(gitDir, ...refNameFromHead.split('/'));
  if (fs.existsSync(refPath)) {
    const ref = fs.readFileSync(refPath, 'utf8').trim();
    if (/^[0-9a-f]{40}$/i.test(ref)) return ref;
  }
  const packedRefsPath = path.join(gitDir, 'packed-refs');
  if (!fs.existsSync(packedRefsPath)) return null;
  const packed = fs.readFileSync(packedRefsPath, 'utf8').split(/\r?\n/);
  for (const line of packed) {
    if (line.startsWith('#') || line.startsWith('^')) continue;
    const [sha = '', refName = ''] = line.split(' ');
    if (refName === refNameFromHead && /^[0-9a-f]{40}$/i.test(sha)) {
      return sha;
    }
  }
  return null;
}

function findFilesUnder(root: string, predicate: (filePath: string) => boolean): string[] {
  if (!fs.existsSync(root)) return [];
  const entries = fs.readdirSync(root, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) return findFilesUnder(full, predicate);
    return entry.isFile() && predicate(full) ? [full] : [];
  });
}

function bundleRootPath(): string {
  return path.join(tauriRoot, 'target', 'release', 'bundle');
}

function hostSidecarPath(): string {
  return path.join(tauriRoot, 'binaries', 'agent-cowork-host-x86_64-pc-windows-msvc.exe');
}

function runtimePeFiles(): string[] {
  return [hostSidecarPath(), path.join(tauriRoot, 'target', 'release', 'agent-cowork-desktop.exe')];
}

function findInstallerFiles(targetVersion: string): string[] {
  const bundleRoot = bundleRootPath();
  const discovered = ['nsis', 'msi'].flatMap((kind) => (
    findFilesUnder(path.join(bundleRoot, kind), (file) => /(?:setup\.exe|\.msi)$/i.test(file))
  ));
  return discovered.filter((file) => path.basename(file).includes(targetVersion));
}

function findUpdaterArtifacts(targetVersion: string): string[] {
  const discovered = findFilesUnder(
    bundleRootPath(),
    (file) => /\.(?:nsis|msi)\.zip(?:\.sig)?$/i.test(file),
  );
  return selectUpdaterArtifacts(discovered, targetVersion);
}

function cleanCanonicalTauriBundle(execute: boolean): void {
  if (!execute) {
    console.log(`[dry-run] clean ${path.relative(repoRoot, bundleRootPath())}`);
    return;
  }
  cleanCanonicalBundleRoot(bundleRootPath(), tauriRoot);
  console.log(`[exec] cleaned ${path.relative(repoRoot, bundleRootPath())}`);
}

function runCanonicalReleasePrerequisites(execute: boolean): void {
  run('python', ['-X', 'utf8', 'scripts/quality_gate.py', '--level', 'full'], {
    execute,
    timeoutMs: FULL_SOURCE_GATE_TIMEOUT_MS,
  });
  run('npm', ['run', 'build:ui'], { execute });
  run('npm', ['run', 'build:host'], { execute });
  run(
    'cargo',
    ['build', '--release', '--locked', '--features', 'custom-protocol'],
    {
      execute,
      cwd: tauriRoot,
    },
  );
}

function signingPowerShellArgs(signingConfig: SigningConfig, files: readonly string[]): string[] {
  const args = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    path.join(repoRoot, 'scripts', 'sign-windows.ps1'),
    ...signingConfig.args,
    '-Files',
    ...files,
  ];
  const timestampUrl = firstEnvValue(['KCW_CODESIGN_TIMESTAMP_URL', 'WINDOWS_SIGNING_TIMESTAMP_URL']);
  if (timestampUrl) args.push('-TimestampUrl', timestampUrl);
  return args;
}

function signingVerificationPowerShellArgs(signingConfig: SigningConfig): string[] {
  const configuredValue = signingConfig.args[1];
  if (!configuredValue) throw new Error(`Signing configuration is incomplete for ${signingConfig.mode}`);
  return signingConfig.mode === 'thumbprint'
    ? ['-ExpectedThumbprint', configuredValue]
    : ['-ExpectedPfx', configuredValue];
}

function tauriSigningConfigPath(): string {
  return path.join(tauriRoot, 'target', `release-signing-config-${process.pid}.json`);
}

function writeTauriSigningConfig(signingConfig: SigningConfig, configPath: string): void {
  const signArgs = signingPowerShellArgs(signingConfig, ['%1']);
  const config = {
    bundle: {
      windows: {
        signCommand: {
          cmd: 'pwsh',
          args: signArgs,
        },
      },
    },
  };
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function runCanonicalTauriPackage(
  signingConfig: SigningConfig | null,
  execute: boolean,
): void {
  if (!signingConfig) {
    const message = productionSigningHelp();
    if (execute) throw new Error(message);
    console.log(`[dry-run] signing blocked: ${message}`);
  }
  const configPath = tauriSigningConfigPath();
  if (execute && signingConfig) writeTauriSigningConfig(signingConfig, configPath);
  try {
    run(
      'cargo',
      ['tauri', 'build', '--ci', '--bundles', 'nsis', '--config', configPath, '--', '--locked'],
      { execute, cwd: tauriRoot },
    );
  } finally {
    if (execute && fs.existsSync(configPath)) fs.rmSync(configPath);
  }
}

function signRuntimeExecutables(
  runtimePaths: readonly string[],
  signingConfig: SigningConfig | null,
  execute: boolean,
): void {
  if (!signingConfig) {
    if (execute) throw new Error(productionSigningHelp());
    console.log('[dry-run] runtime signing deferred until trusted signing configuration is supplied');
    return;
  }
  console.log(`[plan] signing mode: ${signingConfig.mode}`);
  run('pwsh', signingPowerShellArgs(signingConfig, runtimePaths), { execute });
}

function verifyWindowsSignatures(
  files: readonly string[],
  signingConfig: SigningConfig | null,
  execute: boolean,
): void {
  if (!signingConfig) {
    if (execute) throw new Error(productionSigningHelp());
    console.log('[dry-run] signer-bound Authenticode verification deferred until signing is configured');
    return;
  }
  const args = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    path.join(repoRoot, 'scripts', 'sign-windows.ps1'),
    '-VerifyOnly',
    ...signingVerificationPowerShellArgs(signingConfig),
    '-Files',
    ...files,
  ];
  run('pwsh', args, { execute });
}

function ensureSourceUnchangedAfterBuild(expectedCommit: string): void {
  const currentCommit = gitCapture(['rev-parse', 'HEAD']);
  if (currentCommit !== expectedCommit) {
    throw new Error('Source HEAD changed during the release build. Refusing mixed-source provenance.');
  }
  const trackedStatus = gitCapture(['status', '--porcelain', '--untracked-files=no']);
  if (trackedStatus) {
    throw new Error('Tracked source files changed during the release build. Refusing mixed-source provenance.');
  }
}

function updaterSignatureFor(filePath: string, artifactSet: Set<string>): string | null {
  const candidates = [`${filePath}.sig`, filePath.replace(/\.[^.]+$/, '.sig')];
  return candidates.find((candidate) => artifactSet.has(candidate) && fs.existsSync(candidate)) || null;
}

function updateArtifactUrl(baseUrl: string, fileName: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${encodeURIComponent(fileName)}`;
}

function writeFilePlanned(filePath: string, content: string, execute: boolean): void {
  if (!execute) {
    console.log(`[dry-run] write ${path.relative(repoRoot, filePath)}:`);
    console.log(content.trimEnd());
    return;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
  console.log(`[exec] wrote ${path.relative(repoRoot, filePath)}`);
}

const options = parseArgs(process.argv.slice(2));
const version = normalizeVersion(options.version || packageJson.version);
const tag = `v${version}`;
const releasesRoot = path.join(repoRoot, 'releases');
const releaseDir = resolveJailedOutputPath(
  releasesRoot,
  path.join(releasesRoot, tag),
  'Release directory',
  false,
);
const bundlePath = path.join(releaseDir, `agent-cowork-${tag}.bundle`);
const versionPath = path.join(releaseDir, 'VERSION.txt');
const manifestPath = path.join(releaseDir, 'manifest.json');
assertReleaseVersions(projectVersions(), version);
assertChangelogVersion(fs.readFileSync(path.join(repoRoot, 'CHANGELOG.md'), 'utf8'), version);
let installers = findInstallerFiles(version);
let updaterArtifacts = findUpdaterArtifacts(version);
const signingConfig = resolveProductionSigningConfig();
const commit = gitCapture(['rev-parse', 'HEAD']) || readGitHead();
if (!commit || !/^[0-9a-f]{40}$/i.test(commit)) {
  throw new Error('Unable to resolve the full 40-character source commit for release provenance.');
}
const built = new Date().toISOString();

console.log(`release: ${tag}`);
console.log(`mode: ${options.execute ? 'execute' : 'dry-run'}`);
console.log(`commit: ${commit}`);
console.log(`release dir: ${path.relative(repoRoot, releaseDir)}`);

if (options.execute && fs.existsSync(releaseDir)) {
  throw new Error(`Refusing to overwrite an existing release directory: ${releaseDir}`);
}
if (options.execute) {
  const existingTag = gitCapture(['tag', '--list', tag]);
  if (existingTag === tag) {
    throw new Error(`Git tag already exists: ${tag}`);
  }
  const status = gitCapture(['status', '--porcelain']);
  if (status) {
    throw new Error('Working tree is not clean. Commit or stash changes before an executable release.');
  }
  if (!signingConfig) {
    throw new Error(productionSigningHelp());
  }
  if (signingConfig.mode === 'pfx') {
    const pfxPath = signingConfig.args[1];
    if (!pfxPath || !fs.existsSync(pfxPath)) {
      throw new Error(`Production signing PFX does not exist: ${pfxPath || '<missing>'}`);
    }
    if (!firstEnvValue(['KCW_CODESIGN_PFX_PASSWORD', 'WINDOWS_SIGNING_PFX_PASSWORD'])) {
      throw new Error('PFX password is required for non-interactive release signing.');
    }
  }
}

const plannedRuntimePaths = runtimePeFiles();
runCanonicalReleasePrerequisites(options.execute);
// Tauri skips a sidecar already signed by any trusted publisher. Bind it to the
// configured release identity before packaging so the installed copy is correct.
signRuntimeExecutables([hostSidecarPath()], signingConfig, options.execute);
cleanCanonicalTauriBundle(options.execute);
runCanonicalTauriPackage(signingConfig, options.execute);
if (options.execute) {
  installers = findInstallerFiles(version);
  updaterArtifacts = findUpdaterArtifacts(version);
  assertInstallerVersions(installers, version);
} else if (installers.length > 0) {
  assertInstallerVersions(installers, version);
} else {
  console.log('[dry-run] canonical installer version check deferred until the planned Tauri build');
}
signRuntimeExecutables(plannedRuntimePaths, signingConfig, options.execute);
verifyWindowsSignatures([...plannedRuntimePaths, ...installers], signingConfig, options.execute);
if (options.execute) ensureSourceUnchangedAfterBuild(commit);

const runtimeEvidence = plannedRuntimePaths
  .filter((runtimePath) => fs.existsSync(runtimePath))
  .map((runtimePath) => createArtifactEvidence({
    sourcePath: runtimePath,
    archivedPath: runtimePath,
    repoRoot,
  }));

if (!options.execute) {
  console.log(`[dry-run] mkdir ${path.relative(repoRoot, releaseDir)}`);
} else {
  fs.mkdirSync(releaseDir, { recursive: true });
}

const versionContent = `${tag}  commit=${commit}  built=${built}  tag=${tag}\n`;
writeFilePlanned(versionPath, versionContent, options.execute);

git(['bundle', 'create', bundlePath, 'HEAD'], { execute: options.execute });
let bundleEvidence: BundleEvidence = {
  path: path.relative(repoRoot, bundlePath).replaceAll('\\', '/'),
  sha256: null,
  bytes: null,
};
if (options.execute) {
  const evidence = createArtifactEvidence({ sourcePath: bundlePath, archivedPath: bundlePath, repoRoot });
  bundleEvidence = { path: evidence.path, sha256: evidence.sha256, bytes: evidence.bytes };
}

const archivedInstallers: ArtifactEvidence[] = [];
for (const installer of installers) {
  const dest = path.join(releaseDir, path.basename(installer));
  if (!options.execute) {
    console.log(`[dry-run] copy ${path.relative(repoRoot, installer)} -> ${path.relative(repoRoot, dest)}`);
  } else {
    fs.copyFileSync(installer, dest);
    console.log(`[exec] copied ${path.relative(repoRoot, dest)}`);
    archivedInstallers.push(createArtifactEvidence({ sourcePath: installer, archivedPath: dest, repoRoot }));
  }
}

const archivedUpdaterArtifacts: ArtifactEvidence[] = [];
for (const artifact of updaterArtifacts) {
  const dest = path.join(releaseDir, path.basename(artifact));
  if (!options.execute) {
    console.log(`[dry-run] copy ${path.relative(repoRoot, artifact)} -> ${path.relative(repoRoot, dest)}`);
  } else {
    fs.copyFileSync(artifact, dest);
    console.log(`[exec] copied ${path.relative(repoRoot, dest)}`);
    archivedUpdaterArtifacts.push(createArtifactEvidence({ sourcePath: artifact, archivedPath: dest, repoRoot }));
  }
}

let updateManifest: string | null = null;
const artifactSet = new Set(updaterArtifacts);
const updatePayload = updaterArtifacts.find((artifact) => !/\.sig$/i.test(artifact));
const updateSignature = updatePayload ? updaterSignatureFor(updatePayload, artifactSet) : null;
if (updatePayload && updateSignature) {
  const latestPath = path.join(releaseDir, 'latest.json');
  const updateBaseUrl = process.env.KCW_UPDATE_BASE_URL || `https://updates.agent-cowork.local/${tag}`;
  const latest = {
    version,
    notes: `Agent Cowork ${tag}`,
    pub_date: built,
    platforms: {
      'windows-x86_64': {
        signature: fs.readFileSync(updateSignature, 'utf8').trim(),
        url: updateArtifactUrl(updateBaseUrl, path.basename(updatePayload)),
      },
    },
  };
  writeFilePlanned(latestPath, `${JSON.stringify(latest, null, 2)}\n`, options.execute);
  updateManifest = path.relative(repoRoot, latestPath).replaceAll('\\', '/');
} else if (updaterArtifacts.length) {
  console.log('[plan] updater artifacts found but no signed payload/signature pair was detected');
} else {
  console.log('[plan] no updater artifacts: tauri.conf disables createUpdaterArtifacts; production updater acceptance remains blocked');
}

const manifest = createReleaseManifest({
  version,
  tag,
  sourceCommit: commit,
  built,
  packageName: packageJson.name,
  bundle: bundleEvidence,
  installers: archivedInstallers,
  runtimeExecutables: runtimeEvidence,
  signaturesVerified: options.execute,
  updaterArtifacts: archivedUpdaterArtifacts,
  updateManifest,
  sourceGate: options.execute
    ? 'passed: full local source gate, canonical rebuild, trusted signing, and Authenticode verification'
    : 'dry-run: planned full local source gate, canonical rebuild, and trusted signing (not executed)',
});
writeFilePlanned(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, options.execute);

git(['tag', '-a', tag, '-m', `Release ${tag}`], { execute: options.execute });

console.log(options.execute ? `[release] created ${tag}` : '[release] dry-run complete; rerun with --execute to apply');
