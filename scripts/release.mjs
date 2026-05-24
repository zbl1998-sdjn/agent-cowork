import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const packageJsonPath = path.join(repoRoot, 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
const semverRe = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

process.on('uncaughtException', (error) => {
  console.error(`[release] ${error.message}`);
  process.exit(1);
});

function usage(exitCode = 0) {
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write(`Usage: npm run release -- --version <semver> [--execute] [--skip-ci] [--skip-sign]\n`);
  stream.write(`       npm run release -- <semver> [--execute]\n\n`);
  stream.write(`Default mode is dry-run: it prints the release plan and does not write files, create tags, or build bundles.\n`);
  stream.write(`Use --execute to create releases/v<semver>/VERSION.txt, a git bundle, and an annotated tag.\n`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const options = {
    execute: false,
    skipCi: false,
    skipSign: false,
    version: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') usage(0);
    if (arg === '--execute') {
      options.execute = true;
    } else if (arg === '--skip-ci') {
      options.skipCi = true;
    } else if (arg === '--skip-sign') {
      options.skipSign = true;
    } else if (arg === '--version') {
      options.version = argv[index + 1];
      index += 1;
    } else if (!arg.startsWith('-') && !options.version) {
      options.version = arg;
    } else {
      throw new Error(`Unknown or duplicate argument: ${arg}`);
    }
  }
  return options;
}

function normalizeVersion(version) {
  if (!version) {
    throw new Error('Missing release version. Pass --version <semver>.');
  }
  const normalized = version.startsWith('v') ? version.slice(1) : version;
  if (!semverRe.test(normalized)) {
    throw new Error(`Invalid SemVer version: ${version}`);
  }
  return normalized;
}

function commandLine(command, args) {
  return [command, ...args].map((part) => (/\s/.test(part) ? `"${part}"` : part)).join(' ');
}

function spawnSpec(command, args) {
  if (process.platform !== 'win32') {
    return { command, args };
  }
  return {
    command: process.env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', commandLine(command, args)],
  };
}

function run(command, args, options = {}) {
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

function git(args, options = {}) {
  return run('git', ['-c', `safe.directory=${repoRoot.replaceAll('\\', '/')}`, ...args], options);
}

function gitCapture(args) {
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
  return result.stdout.trim();
}

function readGitHeadShort() {
  const gitDir = path.join(repoRoot, '.git');
  const headPath = path.join(gitDir, 'HEAD');
  if (!fs.existsSync(headPath)) return null;
  const head = fs.readFileSync(headPath, 'utf8').trim();
  if (/^[0-9a-f]{40}$/i.test(head)) return head.slice(0, 7);
  const refMatch = /^ref:\s+(.+)$/.exec(head);
  if (!refMatch) return null;
  const refPath = path.join(gitDir, ...refMatch[1].split('/'));
  if (fs.existsSync(refPath)) {
    const ref = fs.readFileSync(refPath, 'utf8').trim();
    if (/^[0-9a-f]{40}$/i.test(ref)) return ref.slice(0, 7);
  }
  const packedRefsPath = path.join(gitDir, 'packed-refs');
  if (!fs.existsSync(packedRefsPath)) return null;
  const packed = fs.readFileSync(packedRefsPath, 'utf8').split(/\r?\n/);
  for (const line of packed) {
    if (line.startsWith('#') || line.startsWith('^')) continue;
    const [sha, refName] = line.split(' ');
    if (refName === refMatch[1] && /^[0-9a-f]{40}$/i.test(sha)) {
      return sha.slice(0, 7);
    }
  }
  return null;
}

function ensureInside(child, parent) {
  const relative = path.relative(parent, child);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing path outside ${parent}: ${child}`);
  }
}

function findInstallerFiles() {
  const installersDir = path.join(repoRoot, 'installers');
  if (!fs.existsSync(installersDir)) return [];
  return fs
    .readdirSync(installersDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(exe|msi)$/i.test(entry.name))
    .map((entry) => path.join(installersDir, entry.name));
}

function writeFilePlanned(filePath, content, execute) {
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

const archivedInstallers = [];
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

const manifest = {
  version,
  tag,
  commit,
  built,
  packageName: packageJson.name,
  bundle: path.relative(repoRoot, bundlePath).replaceAll('\\', '/'),
  installers: archivedInstallers.map((item) => item.replaceAll('\\', '/')),
};
writeFilePlanned(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, options.execute);

git(['tag', '-a', tag, '-m', `Release ${tag}`], { execute: options.execute });

console.log(options.execute ? `[release] created ${tag}` : '[release] dry-run complete; rerun with --execute to apply');
