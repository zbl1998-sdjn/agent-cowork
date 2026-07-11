// 源文件行数上限门禁(防上帝类)(scripts · 门禁(gate))
// ---------------------------------------------------------------------------
// 职责:递归扫描 host/UI/resources/Tauri/local-agent/services 等源码目录下的
//   .js/.mjs/.ts/.tsx/.rs/.go 文件。新文件超过 250 行、既有大文件突破静态
//   no-growth baseline、baseline 失效或文件超过 400 行均失败。跳过 .d.ts、生成的
//   UI .js、测试文件。用来阻断新增上帝类并持续偿还既有尺寸债务。
// 用法:npm run check:filesize(经 run-host-node.mjs 运行),也是 npm run check
//   聚合门禁的一环。
// 依赖:./filesize-policy、./filesize-baseline.json;策略违例即 exit 1 阻断。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evaluateFileSizePolicy,
  parseFileSizeBaseline,
} from './filesize-policy.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_PATH = path.join(ROOT, 'scripts', 'filesize-baseline.json');

const ROOTS = [
  path.join(ROOT, 'apps', 'host', 'src'),
  path.join(ROOT, 'apps', 'windows-client', 'ui', 'src'),
  path.join(ROOT, 'apps', 'windows-client', 'resources-src'),
  path.join(ROOT, 'apps', 'windows-client', 'src-tauri', 'src'),
  path.join(ROOT, 'apps', 'local-agent'),
  path.join(ROOT, 'services'),
];

const EXTENSIONS = new Set(['.js', '.mjs', '.ts', '.tsx', '.rs', '.go']);

function toPosix(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

function rel(filePath: string): string {
  return toPosix(path.relative(ROOT, filePath));
}

function isGeneratedUiJs(filePath: string): boolean {
  const uiSrc = `${path.join(ROOT, 'apps', 'windows-client', 'ui', 'src')}${path.sep}`;
  return filePath.startsWith(uiSrc) && path.extname(filePath) === '.js';
}

function isTestFile(filePath: string): boolean {
  return /\.(test|spec)\.(js|mjs|ts|tsx)$/.test(filePath) || /_test\.go$/.test(filePath);
}

function shouldSkip(filePath: string): boolean {
  const name = path.basename(filePath);
  if (name.endsWith('.d.ts')) return true;
  if (isGeneratedUiJs(filePath)) return true;
  if (isTestFile(filePath)) return true;
  return false;
}

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'target' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (EXTENSIONS.has(path.extname(full)) && !shouldSkip(full)) {
      out.push(full);
    }
  }
  return out;
}

function lineCount(filePath: string): number {
  const text = fs.readFileSync(filePath, 'utf8');
  if (text.length === 0) return 0;
  return text.split(/\r\n|\r|\n/).length;
}

const files = ROOTS.flatMap((root) => walk(root));
let policyResult;
try {
  const baseline = parseFileSizeBaseline(JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')) as unknown);
  const lineCounts = new Map(files.map((file) => [rel(file), lineCount(file)]));
  policyResult = evaluateFileSizePolicy({
    baseline,
    files: lineCounts,
  });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`File size check failed to load its baseline: ${message}`);
  process.exit(1);
}

for (const warning of policyResult.warnings) {
  console.warn(`WARN ${warning}`);
}

if (policyResult.failures.length) {
  console.error('File size check failed:');
  for (const failure of policyResult.failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(
  `File size check passed (${files.length} source files, `
  + `${policyResult.warnings.length} no-growth baseline warnings).`,
);
