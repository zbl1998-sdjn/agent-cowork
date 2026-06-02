// 源文件行数上限门禁(防上帝类)(scripts · 门禁(gate))
// ---------------------------------------------------------------------------
// 职责:递归扫描 host/UI/resources/Tauri/local-agent/services 等源码目录下的
//   .js/.mjs/.ts/.tsx/.rs/.go 文件,按行数判定:超软上限(250)仅 WARN,超硬上限
//   (400)则失败——除非在 HARD_WAIVERS 白名单内显式豁免。跳过 .d.ts、生成的 UI .js、
//   测试文件。用来逼迫大文件拆分,避免上帝类。
// 用法:npm run check:filesize(经 run-host-node.mjs 运行),也是 npm run check
//   聚合门禁的一环。
// 依赖:无外部依赖;硬上限违例即 exit 1 阻断,软上限只告警不阻断。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOFT_LIMIT = 250;
const HARD_LIMIT = 400;

const ROOTS = [
  path.join(ROOT, 'apps', 'host', 'src'),
  path.join(ROOT, 'apps', 'windows-client', 'ui', 'src'),
  path.join(ROOT, 'apps', 'windows-client', 'resources-src'),
  path.join(ROOT, 'apps', 'windows-client', 'src-tauri', 'src'),
  path.join(ROOT, 'apps', 'local-agent'),
  path.join(ROOT, 'services'),
];

const EXTENSIONS = new Set(['.js', '.mjs', '.ts', '.tsx', '.rs', '.go']);
const HARD_WAIVERS = new Map<string, string>([
  // All P0 god-class waivers retired — every listed file is back under the limits:
  // - P0-T2 retired: server.ts (~133 lines) — assembly thinned to "build deps +
  //   mount routes", middleware → http/middleware/*, handlers → routes/*.
  // - P0-T4 retired: App.tsx (~234 lines) — chat-stream callbacks / Settings tabs /
  //   composer types / app-types splits got it under the soft limit.
  // - P0-T6 retired: memory-store (~44 lines, now .ts; the .js target is gone after
  //   JS→TS) — split into store(IO) / layers / query / utils.
  // Re-add an entry (relative path → reason) here only if a file legitimately needs
  // to exceed the hard limit (400).
]);

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
const warnings: string[] = [];
const failures: string[] = [];

for (const file of files) {
  const lines = lineCount(file);
  const relative = rel(file);
  if (lines > HARD_LIMIT) {
    const waiver = HARD_WAIVERS.get(relative);
    if (waiver) {
      warnings.push(`${relative}: ${lines} lines over hard limit (${HARD_LIMIT}); waived: ${waiver}`);
    } else {
      failures.push(`${relative}: ${lines} lines exceeds hard limit (${HARD_LIMIT})`);
    }
  } else if (lines > SOFT_LIMIT) {
    warnings.push(`${relative}: ${lines} lines over soft limit (${SOFT_LIMIT})`);
  }
}

for (const warning of warnings) {
  console.warn(`WARN ${warning}`);
}

if (failures.length) {
  console.error('File size check failed:');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(`File size check passed (${files.length} source files, ${warnings.length} warnings).`);
