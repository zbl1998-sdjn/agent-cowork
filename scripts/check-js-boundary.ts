import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESOURCE_DIR = path.join(ROOT, 'apps', 'windows-client', 'resources');
const RESOURCE_SOURCE_DIR = path.join(ROOT, 'apps', 'windows-client', 'resources-src');
const ALLOWED_BOOTSTRAPS = new Set([
  'scripts/host-ts-loader.mjs',
  'scripts/run-host-node.mjs',
]);
const SKIP_DIRS = new Set([
  '.git',
  '.AgentCowork',
  '.KimiCowork',
  'node_modules',
  'build',
  'dist',
  'coverage',
  'reports',
  'releases',
  'apps/windows-client/resources/python-embedded',
  'apps/windows-client/ui-dist',
  'apps/windows-client/ui/node_modules',
  'apps/windows-client/src-tauri/target',
]);

function toPosix(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

function rel(filePath: string): string {
  return toPosix(path.relative(ROOT, filePath));
}

function isSkipped(relativePath: string): boolean {
  const normalized = relativePath.split('\\').join('/');
  return normalized.split('/').some((_, index, parts) => {
    return SKIP_DIRS.has(parts.slice(0, index + 1).join('/'));
  });
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const relative = rel(full);
    if (isSkipped(relative)) continue;
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (entry.isFile() && ['.js', '.mjs'].includes(path.extname(entry.name))) {
      out.push(relative);
    }
  }
  return out;
}

function stdoutText(stdout: string | Buffer | undefined): string {
  return Buffer.isBuffer(stdout) ? stdout.toString('utf8') : String(stdout || '');
}

function trackedJsFiles(): string[] {
  const git = spawnSync('git', ['-c', `safe.directory=${ROOT}`, 'ls-files', '-z', '--', '*.js', '*.mjs'], {
    cwd: ROOT,
    encoding: 'buffer',
    windowsHide: true,
  });
  if (git.status === 0 && git.stdout && stdoutText(git.stdout).length > 0) {
    return stdoutText(git.stdout).split('\0').filter((file) => file && !isSkipped(file)).sort();
  }
  return walk(ROOT).sort();
}

function isGeneratedResourceScript(relativePath: string): boolean {
  const resourcePrefix = `${rel(RESOURCE_DIR)}/`;
  if (!relativePath.startsWith(resourcePrefix) || !relativePath.endsWith('.js')) return false;
  const sourceName = `${path.basename(relativePath, '.js')}.ts`;
  return fs.existsSync(path.join(RESOURCE_SOURCE_DIR, sourceName));
}

const files = trackedJsFiles();
const unexpected = files.filter((file) => {
  return !ALLOWED_BOOTSTRAPS.has(file) && !isGeneratedResourceScript(file);
});

if (unexpected.length > 0) {
  console.error('JS/TS boundary check failed: unexpected JavaScript source files remain.');
  for (const file of unexpected) {
    console.error(`- ${file}`);
  }
  process.exit(1);
}

const bootstraps = files.filter((file) => ALLOWED_BOOTSTRAPS.has(file)).length;
const generatedResources = files.filter(isGeneratedResourceScript).length;
console.log(`JS/TS boundary check passed (${bootstraps} loader bootstraps, ${generatedResources} generated resource scripts).`);
