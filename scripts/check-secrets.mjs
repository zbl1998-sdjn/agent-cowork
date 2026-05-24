import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set([
  '.git',
  '.AgentCowork',
  '.KimiCowork',
  'node_modules',
  'coverage',
  'dist',
  'build',
  'target',
  'ui-dist',
  'releases',
  'reports',
  'installers',
]);
const WALK_FALLBACK_SKIP_BASENAMES = new Set([
  '.env',
  '.env.local',
]);
const TEXT_EXTENSIONS = new Set([
  '.css',
  '.go',
  '.html',
  '.js',
  '.json',
  '.md',
  '.mjs',
  '.ps1',
  '.rs',
  '.sql',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.yaml',
  '.yml',
]);
const DETECTORS = [
  { id: 'private-key', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g },
  { id: 'github-token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{30,}\b/g },
  { id: 'github-pat', re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { id: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g },
  { id: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { id: 'api-key', re: /\bsk-[A-Za-z0-9][A-Za-z0-9._-]{28,}\b/g },
  {
    id: 'secret-assignment',
    re: /\b(?:api[_-]?key|api[_-]?token|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd)\s*[:=]\s*["']?([A-Za-z0-9_./+=-]{32,})["']?/gi,
  },
];

function toPosix(filePath) {
  return filePath.split(path.sep).join('/');
}

function isTestPath(relativePath) {
  return /(^|\/)(test|tests|fixtures)(\/|$)/.test(relativePath)
    || /\.(test|spec)\.(js|mjs|ts|tsx)$/.test(relativePath);
}

function shouldSkip(relativePath) {
  if (!relativePath || relativePath.startsWith('..')) return true;
  const normalized = relativePath.split('\\').join('/');
  if (isTestPath(normalized)) return true;
  if (normalized.endsWith('.snap')) return true;
  if (normalized.endsWith('.tsbuildinfo')) return true;
  if (normalized.split('/').some((segment) => SKIP_DIRS.has(segment))) return true;
  const ext = path.extname(normalized).toLowerCase();
  return ext && !TEXT_EXTENSIONS.has(ext);
}

export function shouldSkipWalkFallback(relativePath) {
  const normalized = relativePath.split('\\').join('/');
  const basename = path.posix.basename(normalized);
  return WALK_FALLBACK_SKIP_BASENAMES.has(basename)
    || basename.startsWith('.fuse_hidden');
}

function looksLikePlaceholder(value) {
  return /(?:dummy|example|fake|placeholder|redacted|sample|test|todo|your[_-]?key|do-not-echo)/i.test(value);
}

function lineForIndex(text, index) {
  return text.slice(0, index).split(/\r\n|\r|\n/).length;
}

function safeLine(text, index, matched) {
  const lineStart = text.lastIndexOf('\n', index) + 1;
  const lineEnd = text.indexOf('\n', index);
  const raw = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd);
  return raw.replace(matched, '[REDACTED]').trim().slice(0, 160);
}

function scanDetector(text, relativePath, detector) {
  const findings = [];
  detector.re.lastIndex = 0;
  for (const match of text.matchAll(detector.re)) {
    const matched = match[0];
    const secretValue = match[1] || matched;
    if (looksLikePlaceholder(secretValue)) continue;
    findings.push({
      detector: detector.id,
      path: relativePath,
      line: lineForIndex(text, match.index || 0),
      excerpt: safeLine(text, match.index || 0, matched),
    });
  }
  return findings;
}

export function scanTextForSecrets(text, relativePath = 'inline') {
  if (shouldSkip(relativePath)) return [];
  return DETECTORS.flatMap((detector) => scanDetector(text, relativePath, detector));
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    const relative = toPosix(path.relative(ROOT, full));
    if (shouldSkipWalkFallback(relative)) continue;
    if (shouldSkip(relative)) continue;
    if (entry.isDirectory()) walk(full, out);
    else out.push(relative);
  }
  return out;
}

export function candidateFiles() {
  const git = spawnSync('git', ['-c', `safe.directory=${ROOT}`, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: ROOT,
    encoding: 'buffer',
    windowsHide: true,
  });
  if (git.status === 0 && git.stdout?.length) {
    return git.stdout.toString('utf8').split('\0').filter(Boolean).map((item) => item.split('\\').join('/')).filter((item) => !shouldSkip(item));
  }
  return walk(ROOT);
}

export function scanRepoForSecrets(files = candidateFiles()) {
  const findings = [];
  for (const relative of files) {
    const full = path.join(ROOT, relative);
    if (!fs.existsSync(full)) continue;
    const stat = fs.statSync(full);
    if (!stat.isFile() || stat.size > 512 * 1024) continue;
    const text = fs.readFileSync(full, 'utf8');
    findings.push(...scanTextForSecrets(text, relative));
  }
  return findings;
}

function main() {
  const findings = scanRepoForSecrets();
  if (findings.length) {
    console.error(`Secret scan failed (${findings.length} finding${findings.length === 1 ? '' : 's'}):`);
    for (const finding of findings) {
      console.error(`- ${finding.path}:${finding.line} ${finding.detector} ${finding.excerpt}`);
    }
    process.exit(1);
  }
  console.log('Secret scan passed.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
