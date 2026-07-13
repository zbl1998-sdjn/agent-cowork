// 仓库明文凭据扫描门禁(scripts · 门禁(gate))
// ---------------------------------------------------------------------------
// 职责:遍历仓库文本文件(优先 git ls-files 含未跟踪文件,失败回退磁盘遍历;跳过
//   二进制及构建产物目录;测试、fixtures 与已跟踪报告同样纳入),
//   用一组正则探测器匹配私钥、
//   GitHub token/PAT、Slack/AWS/OpenAI 风格 key 以及 api_key=/password= 等赋值形态。
//   命中含 dummy/fake/test/sample 等占位词的值会被忽略,降低误报。导出
//   scanTextForSecrets / scanRepoForSecrets 等供测试与其他门禁复用。
// 用法:npm run check:secrets(经 run-host-node.mjs 运行),也是 npm run check
//   聚合门禁的一环;仅作为主入口时执行扫描。
// 依赖:git(取候选文件清单);命中任一疑似凭据即 exit 1 阻断(输出已脱敏)。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

type SecretDetector = {
  id: string;
  re: RegExp;
};

export type SecretFinding = {
  detector: string;
  path: string;
  line: number;
  excerpt: string;
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set([
  '.git',
  '.claude',
  '.AgentCowork',
  '.KimiCowork',
  'node_modules',
  'dist',
  'build',
  'target',
  'ui-dist',
  'releases',
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
const DETECTORS: SecretDetector[] = [
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

function toPosix(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

function isGeneratedCoveragePath(normalized: string): boolean {
  if (normalized === 'reports/coverage/generated'
    || normalized.startsWith('reports/coverage/generated/')
    || normalized.startsWith('reports/coverage/host-v8-')
    || normalized === 'reports/coverage/host-coverage-latest.txt') {
    return true;
  }
  const segments = normalized.split('/');
  const coverageIndex = segments.indexOf('coverage');
  return coverageIndex >= 0
    && !(coverageIndex === 1 && segments[0] === 'reports');
}

function shouldSkip(relativePath: string): boolean {
  if (!relativePath || relativePath.startsWith('..')) return true;
  const normalized = relativePath.split('\\').join('/');
  if (isGeneratedCoveragePath(normalized)) return true;
  if (normalized.endsWith('.snap')) return true;
  if (normalized.endsWith('.tsbuildinfo')) return true;
  if (normalized.split('/').some((segment) => SKIP_DIRS.has(segment))) return true;
  const ext = path.extname(normalized).toLowerCase();
  return Boolean(ext && !TEXT_EXTENSIONS.has(ext));
}

export function shouldSkipWalkFallback(relativePath: string): boolean {
  const normalized = relativePath.split('\\').join('/');
  const slash = normalized.lastIndexOf('/');
  const basename = slash === -1 ? normalized : normalized.slice(slash + 1);
  return WALK_FALLBACK_SKIP_BASENAMES.has(basename)
    || basename.startsWith('.fuse_hidden');
}

function looksLikePlaceholder(value: string): boolean {
  return /(?:dummy|example|fake|placeholder|redacted|sample|test|todo|your[_-]?key|do-not-echo)/i.test(value);
}

function lineForIndex(text: string, index: number): number {
  return text.slice(0, index).split(/\r\n|\r|\n/).length;
}

function safeLine(text: string, index: number, matched: string): string {
  const lineStart = text.lastIndexOf('\n', index) + 1;
  const lineEnd = text.indexOf('\n', index);
  const raw = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd);
  return raw.replace(matched, '[REDACTED]').trim().slice(0, 160);
}

function scanDetector(text: string, relativePath: string, detector: SecretDetector): SecretFinding[] {
  const findings: SecretFinding[] = [];
  detector.re.lastIndex = 0;
  for (const match of text.matchAll(detector.re)) {
    const matched = match[0] || '';
    const secretValue = match[1] || matched;
    if (looksLikePlaceholder(secretValue)) continue;
    const index = match.index ?? 0;
    findings.push({
      detector: detector.id,
      path: relativePath,
      line: lineForIndex(text, index),
      excerpt: safeLine(text, index, matched),
    });
  }
  return findings;
}

export function scanTextForSecrets(text: string, relativePath = 'inline'): SecretFinding[] {
  if (shouldSkip(relativePath)) return [];
  return DETECTORS.flatMap((detector) => scanDetector(text, relativePath, detector));
}

function walk(dir: string, out: string[] = []): string[] {
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

function stdoutText(stdout: string | Buffer | undefined): string {
  return Buffer.isBuffer(stdout) ? stdout.toString('utf8') : String(stdout || '');
}

export function candidateFiles(): string[] {
  const git = spawnSync('git', ['-c', `safe.directory=${ROOT}`, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: ROOT,
    encoding: 'buffer',
    windowsHide: true,
  });
  if (git.status === 0 && git.stdout && stdoutText(git.stdout).length) {
    return stdoutText(git.stdout)
      .split('\0')
      .filter(Boolean)
      .map((item) => item.split('\\').join('/'))
      .filter((item) => !shouldSkip(item));
  }
  return walk(ROOT);
}

export function scanRepoForSecrets(files = candidateFiles()): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const relative of files) {
    if (shouldSkip(relative)) continue;
    const full = path.join(ROOT, relative);
    if (!fs.existsSync(full)) continue;
    const stat = fs.statSync(full);
    if (!stat.isFile()) continue;
    const text = fs.readFileSync(full, 'utf8');
    findings.push(...scanTextForSecrets(text, relative));
  }
  return findings;
}

function main(): void {
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

const argv = (process as { argv?: string[] }).argv || [];
if (argv[1] && path.resolve(argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
