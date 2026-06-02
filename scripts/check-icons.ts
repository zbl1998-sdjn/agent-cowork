// UI 图标 emoji 单一来源门禁(scripts · 门禁(gate))
// ---------------------------------------------------------------------------
// 职责:扫描 UI 源码(apps/windows-client/ui/src 下的 .ts/.tsx,排除测试与
//   lib/icons.ts),禁止在 JSX/字符串中裸写 chrome 图标 emoji(📁📦📥📌⚙️📝📎🕘),
//   必须改用 lib/icons.ts 暴露的 ICONS.* 常量,保证图标集是唯一来源(将来可只改
//   一处切换为 SVG 库)。注释会先剥离再扫描;面板说明文案等个别合法用例走 WAIVERS
//   白名单。新增图标需同时改本文件 ICON_EMOJI 与 lib/icons.ts。
// 用法:npm run check:icons(经 run-host-node.mjs 运行),也是 npm run check
//   聚合门禁的一环。
// 依赖:无外部依赖;发现裸写 emoji 即 exit 1 阻断。
//
// Lint guard: every chrome icon emoji in the UI must go through ICONS.* in
// lib/icons.ts, never raw in JSX or string literals. Keeps the icon set a
// single source of truth so we can swap to a real SVG library later by
// editing one file.
//
// Whitelist:
//   - lib/icons.ts itself (the definition point)
//   - test files (*.test.tsx) — they may assert on rendered text
//   - JS/TS comments (stripped before scanning)
//   - Inside intro / explanation strings inside <p className="panel-intro"> —
//     waiver list below covers the documented cases.
//
// Run via `npm run check:icons`.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(process.env.KCW_ARCH_CHECK_ROOT || DEFAULT_ROOT);
const UI_SRC = path.join(ROOT, 'apps', 'windows-client', 'ui', 'src');

// Each entry is [emoji, constantName]. Add to BOTH here AND lib/icons.ts when
// introducing a new chrome icon.
const ICON_EMOJI = [
  ['📁', 'FOLDER'],
  ['📦', 'PACKAGE'],
  ['📥', 'DOWNLOAD'],
  ['📌', 'PIN'],
  ['⚙️', 'SETTINGS'],
  ['⚙', 'SETTINGS'], // bare cog also caught — must use ICONS.SETTINGS (which is the FE0F-variant form)
  ['📝', 'TEMPLATE'],
  ['📎', 'PAPERCLIP'],
  ['🕘', 'HISTORY'],
] satisfies readonly [string, string][];

// Files that legitimately mention the emoji as documentation strings (panel
// intros explaining "look for the 📥 button"). Keep this list small — most
// real uses should be ICONS.X.
const WAIVERS = new Set([
  // RuntimeDependenciesPanelView's panel-intro text describes what the
  // download button looks like; the actual button uses ICONS.DOWNLOAD.
  'apps/windows-client/ui/src/components/panels/RuntimeDependenciesPanelView.tsx',
]);

function stripComments(text: string): string {
  const out: string[] = [];
  let i = 0;
  let inLine = false;
  let inBlock = false;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;

  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (inLine) {
      if (ch === '\n') {
        inLine = false;
        out.push(ch);
      }
      i += 1;
      continue;
    }
    if (inBlock) {
      if (ch === '*' && next === '/') {
        inBlock = false;
        i += 2;
        continue;
      }
      if (ch === '\n') out.push(ch);
      i += 1;
      continue;
    }
    if (inSingle) {
      if (ch === '\\') {
        out.push(ch, next ?? '');
        i += 2;
        continue;
      }
      if (ch === "'") inSingle = false;
      if (ch) out.push(ch);
      i += 1;
      continue;
    }
    if (inDouble) {
      if (ch === '\\') {
        out.push(ch, next ?? '');
        i += 2;
        continue;
      }
      if (ch === '"') inDouble = false;
      if (ch) out.push(ch);
      i += 1;
      continue;
    }
    if (inTemplate) {
      if (ch === '\\') {
        out.push(ch, next ?? '');
        i += 2;
        continue;
      }
      if (ch === '`') inTemplate = false;
      if (ch) out.push(ch);
      i += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      inLine = true;
      i += 2;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlock = true;
      i += 2;
      continue;
    }
    if (ch === "'") inSingle = true;
    if (ch === '"') inDouble = true;
    if (ch === '`') inTemplate = true;
    if (ch) out.push(ch);
    i += 1;
  }
  return out.join('');
}

function toPosix(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

function relFromRoot(filePath: string): string {
  return toPosix(path.relative(ROOT, filePath));
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (/\.(tsx|ts)$/.test(entry.name) && !/\.(test|spec)\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const files = walk(UI_SRC).filter((file) => !file.endsWith(path.join('lib', 'icons.ts')));
const violations: string[] = [];

for (const file of files) {
  const rel = relFromRoot(file);
  if (WAIVERS.has(rel)) continue;
  const raw = fs.readFileSync(file, 'utf8');
  const stripped = stripComments(raw);
  for (const [emoji, name] of ICON_EMOJI) {
    if (stripped.includes(emoji)) {
      // Locate first occurrence line number in the original text for the report.
      const index = raw.indexOf(emoji);
      const line = index >= 0 ? raw.slice(0, index).split('\n').length : 0;
      violations.push(`${rel}:${line}: naked ${emoji} — use ICONS.${name} from lib/icons.ts`);
    }
  }
}

if (violations.length) {
  console.error('Icon-usage check failed:');
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log(`Icon-usage check passed (${files.length} source files, ${ICON_EMOJI.length} icons).`);
