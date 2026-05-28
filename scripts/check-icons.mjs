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
import { stripComments } from './check-arch.mjs';

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
];

// Files that legitimately mention the emoji as documentation strings (panel
// intros explaining "look for the 📥 button"). Keep this list small — most
// real uses should be ICONS.X.
const WAIVERS = new Set([
  // RuntimeDependenciesPanelView's panel-intro text describes what the
  // download button looks like; the actual button uses ICONS.DOWNLOAD.
  'apps/windows-client/ui/src/components/panels/RuntimeDependenciesPanelView.tsx',
]);

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function relFromRoot(p) {
  return toPosix(path.relative(ROOT, p));
}

function walk(dir, out = []) {
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

const files = walk(UI_SRC).filter((f) => !f.endsWith(path.join('lib', 'icons.ts')));
const violations = [];

for (const file of files) {
  const rel = relFromRoot(file);
  if (WAIVERS.has(rel)) continue;
  const raw = fs.readFileSync(file, 'utf8');
  const stripped = stripComments(raw);
  for (const [emoji, name] of ICON_EMOJI) {
    if (stripped.includes(emoji)) {
      // Locate first occurrence line number in the ORIGINAL text for the report.
      const idx = raw.indexOf(emoji);
      const line = idx >= 0 ? raw.slice(0, idx).split('\n').length : 0;
      violations.push(`${rel}:${line}: naked ${emoji} — use ICONS.${name} from lib/icons.ts`);
    }
  }
}

if (violations.length) {
  console.error('Icon-usage check failed:');
  for (const v of violations) console.error(`- ${v}`);
  process.exit(1);
}

console.log(`Icon-usage check passed (${files.length} source files, ${ICON_EMOJI.length} icons).`);
