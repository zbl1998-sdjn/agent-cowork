import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOFT_LIMIT = 250;
const HARD_LIMIT = 400;

const ROOTS = [
  path.join(ROOT, 'apps', 'host', 'src'),
  path.join(ROOT, 'apps', 'windows-client', 'ui', 'src'),
  path.join(ROOT, 'apps', 'windows-client', 'src-tauri', 'src'),
  path.join(ROOT, 'apps', 'local-agent'),
  path.join(ROOT, 'services'),
];

const EXTENSIONS = new Set(['.js', '.mjs', '.ts', '.tsx', '.rs', '.go']);
const HARD_WAIVERS = new Map([
  ['apps/host/src/server.js', 'P0-T2 splits server assembly, middleware, and routes'],
  // P0-T4 retired: App.tsx is back under the soft limit after extracting the
  // chat-stream callbacks (Settings tabs / composer types / app-types splits
  // got it down earlier). Re-add if it ever creeps back over.
  ['apps/host/src/memory/memory-store.js', 'P0-T6 splits memory IO, layers, and query logic'],
]);

function toPosix(filePath) {
  return filePath.split(path.sep).join('/');
}

function rel(filePath) {
  return toPosix(path.relative(ROOT, filePath));
}

function isGeneratedUiJs(filePath) {
  const uiSrc = path.join(ROOT, 'apps', 'windows-client', 'ui', 'src') + path.sep;
  return filePath.startsWith(uiSrc) && path.extname(filePath) === '.js';
}

function isTestFile(filePath) {
  return /\.(test|spec)\.(js|mjs|ts|tsx)$/.test(filePath) || /_test\.go$/.test(filePath);
}

function shouldSkip(filePath) {
  const name = path.basename(filePath);
  if (name.endsWith('.d.ts')) return true;
  if (isGeneratedUiJs(filePath)) return true;
  if (isTestFile(filePath)) return true;
  return false;
}

function walk(dir, out = []) {
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

function lineCount(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  if (text.length === 0) return 0;
  return text.split(/\r\n|\r|\n/).length;
}

const files = ROOTS.flatMap((root) => walk(root));
const warnings = [];
const failures = [];

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
