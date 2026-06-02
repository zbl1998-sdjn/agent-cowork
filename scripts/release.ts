// 版本发布流水线:跑 CI、生成 git bundle、归档安装包并打标签(scripts · 构建)
// ---------------------------------------------------------------------------
// 职责:校验 SemVer 版本与工作区干净度;默认 dry-run 仅打印发布计划,--execute 时
//   依次执行 CI 门禁(除非 --skip-ci)、写 releases/v<ver>/VERSION.txt、创建源码
//   git bundle、签名并归档 installers/*.exe|msi(除非 --skip-sign)、归档 Tauri
//   updater 产物并生成 latest.json/manifest.json,最后打带注释的 git tag v<ver>。
// 用法:npm run release -- --version <semver> [--execute] [--skip-ci] [--skip-sign]
//   (即 node scripts/run-host-node.mjs scripts/release.ts);省略 --execute 为预演。
// 依赖:npm run ci、git bundle/tag、scripts/sign-windows.ps1、KCW_UPDATE_BASE_URL。

import { spawnSync } from 'node:child_process';
import type { SpawnSyncResult } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type PackageJson = {
  name: string;
  version: string;
};

type ReleaseOptions = {
  execute: boolean;
  skipCi: boolean;
  skipSign: boolean;
  version: string | null;
};

type RunOptions = {
  execute?: boolean;
  cwd?: string;
  capture?: boolean;
};

type CommandSpec = {
  command: string;
  args: string[];
};

type CommandResult = SpawnSyncResult<string | Buffer> | {
  status: number;
  stdout: string;
  stderr: string;
};

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
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

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requiredArg(value: string | undefined, message: string): string {
  if (value === undefined) throw new Error(message);
  return value;
}

function usage(exitCode = 0): never {
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write(`Usage: npm run release -- --version <semver> [--execute] [--skip-ci] [--skip-sign]\n`);
  stream.write(`       npm run release -- <semver> [--execute]\n\n`);
  stream.write(`Default mode is dry-run: it prints the release plan and does not write files, create tags, or build bundles.\n`);
  stream.write(`Use --execute to create releases/v<semver>/VERSION.txt, a git bundle, and an annotated tag.\n`);
  process.exit(exitCode);
}

function parseArgs(argv: string[]): ReleaseOptions {
  const options: ReleaseOptions = {
    execute: false,
    skipCi: false,
    skipSign: false,
    version: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = requiredArg(argv[index], 'Missing release argument');
    if (arg === '--help' || arg === '-h') usage(0);
    if (arg === '--execute') {
      options.execute = true;
    } else if (arg === '--skip-ci') {
      options.skipCi = true;
    } else if (arg === '--skip-sign') {
      options.skipSign = true;
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

function spawnSpec(command: string, args: string[]): CommandSpec {
  if (process.platform !== 'win32') {
    return { command, args };
  }
  return {
    command: process.env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', commandLine(command, args)],
  };
}

function run(command: string, args: string[], options: RunOptions = {}): CommandResult {
  const printable = commandLine(command, args);
  if (!options.execute) {
    console.log(`[dry-run] ${printable}`);
    return { status: 0, stdout: '', stderr: '' };
  }
  console.log(`[exec] ${printable}`);
  const spec = spawnSpec(command, args);
  const result = spawnSync(spec.command, spec.args, {
    cwd: options.cwd || repoRoot,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
    windowsHide: true,
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

function gitCapture(args: string[]): string | null {
  const spec = spawnSpec('git', ['-c', `safe.directory=${repoRoot.replaceAll('\\', '/')}`, ...args]);
  const result = spawnSync(spec.command, spec.args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: 'pipe',
    windowsHide: true,
  });
  if (result.status !== 0) {
    return null;
  }
  const stdout = typeof result.stdout === 'string' ? result.stdout : result.stdout?.toString('utf8') ?? '';
  return stdout.trim();
}

function readGitHeadShort(): string | null {
  const gitDir = path.join(repoRoot, '.git');
  const headPath = path.join(gitDir, 'HEAD');
  if (!fs.existsSync(headPath)) return null;
  const head = fs.readFileSync(headPath, 'utf8').trim();
  if (/^[0-9a-f]{40}$/i.test(head)) return head.slice(0, 7);
  const refMatch = /^ref:\s+(.+)$/.exec(head);
  if (!refMatch) return null;
  const refNameFromHead = refMatch[1];
  if (!refNameFromHead) return null;
  const refPath = path.join(gitDir, ...refNameFromHead.split('/'));
  if (fs.existsSync(refPath)) {
    const ref = fs.readFileSync(refPath, 'utf8').trim();
    if (/^[0-9a-f]{40}$/i.test(ref)) return ref.slice(0, 7);
  }
  const packedRefsPath = path.join(gitDir, 'packed-refs');
  if (!fs.existsSync(packedRefsPath)) return null;
  const packed = fs.readFileSync(packedRefsPath, 'utf8').split(/\r?\n/);
  for (const line of packed) {
    if (line.startsWith('#') || line.startsWith('^')) continue;
    const [sha = '', refName = ''] = line.split(' ');
    if (refName === refNameFromHead && /^[0-9a-f]{40}$/i.test(sha)) {
      return sha.slice(0, 7);
    }
  }
  return null;
}

function ensureInside(child: string, parent: string): void {
  const relative = path.relative(parent, child);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing path outside ${parent}: ${child}`);
  }
}

function findInstallerFiles(): string[] {
  const installersDir = path.join(repoRoot, 'installers');
  if (!fs.existsSync(installersDir)) return [];
  return fs
    .readdirSync(installersDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(exe|msi)$/i.test(entry.name))
    .map((entry) => path.join(installersDir, entry.name));
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

function findUpdaterArtifacts(): string[] {
  const bundleRoot = path.join(repoRoot, 'apps', 'windows-client', 'src-tauri', 'target', 'release', 'bundle');
  return ['nsis-updater', 'msi-updater', 'updater']
    .flatMap((name) => findFilesUnder(path.join(bundleRoot, name), (file) => /\.(zip|sig)$/i.test(file)));
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
const releaseDir = path.join(repoRoot, 'releases', tag);
const bundlePath = path.join(releaseDir, `agent-cowork-${tag}.bundle`);
const versionPath = path.join(releaseDir, 'VERSION.txt');
const manifestPath = path.join(releaseDir, 'manifest.json');
const installers = findInstallerFiles();
const updaterArtifacts = findUpdaterArtifacts();
const commit = gitCapture(['rev-parse', '--short', 'HEAD']) || readGitHeadShort() || 'unknown';
const built = new Date().toISOString();

ensureInside(releaseDir, path.join(repoRoot, 'releases'));

console.log(`release: ${tag}`);
console.log(`mode: ${options.execute ? 'execute' : 'dry-run'}`);
console.log(`commit: ${commit}`);
console.log(`release dir: ${path.relative(repoRoot, releaseDir)}`);

if (options.execute) {
  const existingTag = gitCapture(['tag', '--list', tag]);
  if (existingTag === tag) {
    throw new Error(`Git tag already exists: ${tag}`);
  }
  const status = gitCapture(['status', '--porcelain']);
  if (status) {
    throw new Error('Working tree is not clean. Commit or stash changes before an executable release.');
  }
}

if (!options.skipCi) {
  run('npm', ['run', 'ci'], { execute: options.execute });
} else {
  console.log('[plan] skip CI gate (--skip-ci)');
}

if (!options.execute) {
  console.log(`[dry-run] mkdir ${path.relative(repoRoot, releaseDir)}`);
} else {
  fs.mkdirSync(releaseDir, { recursive: true });
}

const versionContent = `${tag}  commit=${commit}  built=${built}  tag=${tag}\n`;
writeFilePlanned(versionPath, versionContent, options.execute);

git(['bundle', 'create', bundlePath, 'HEAD'], { execute: options.execute });

if (options.skipSign) {
  console.log('[plan] skip signing (--skip-sign)');
} else {
  const signArgs = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    path.join('scripts', 'sign-windows.ps1'),
    '-Files',
    ...installers,
  ];
  if (installers.length) {
    run('pwsh', signArgs, { execute: options.execute });
  } else {
    console.log('[plan] no installers/*.exe or installers/*.msi found; signing step has no files yet');
    console.log(`[dry-run] ${commandLine('pwsh', signArgs)}`);
  }
}

const archivedInstallers: string[] = [];
for (const installer of installers) {
  const dest = path.join(releaseDir, path.basename(installer));
  archivedInstallers.push(path.relative(repoRoot, dest));
  if (!options.execute) {
    console.log(`[dry-run] copy ${path.relative(repoRoot, installer)} -> ${path.relative(repoRoot, dest)}`);
  } else {
    fs.copyFileSync(installer, dest);
    console.log(`[exec] copied ${path.relative(repoRoot, dest)}`);
  }
}

const archivedUpdaterArtifacts: string[] = [];
for (const artifact of updaterArtifacts) {
  const dest = path.join(releaseDir, path.basename(artifact));
  archivedUpdaterArtifacts.push(path.relative(repoRoot, dest));
  if (!options.execute) {
    console.log(`[dry-run] copy ${path.relative(repoRoot, artifact)} -> ${path.relative(repoRoot, dest)}`);
  } else {
    fs.copyFileSync(artifact, dest);
    console.log(`[exec] copied ${path.relative(repoRoot, dest)}`);
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
  console.log('[plan] no Tauri updater artifacts found yet; build with TAURI_SIGNING_PRIVATE_KEY_PATH to create them');
}

const manifest = {
  version,
  tag,
  commit,
  built,
  packageName: packageJson.name,
  bundle: path.relative(repoRoot, bundlePath).replaceAll('\\', '/'),
  installers: archivedInstallers.map((item) => item.replaceAll('\\', '/')),
  updaterArtifacts: archivedUpdaterArtifacts.map((item) => item.replaceAll('\\', '/')),
  updateManifest,
};
writeFilePlanned(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, options.execute);

git(['tag', '-a', tag, '-m', `Release ${tag}`], { execute: options.execute });

console.log(options.execute ? `[release] created ${tag}` : '[release] dry-run complete; rerun with --execute to apply');
