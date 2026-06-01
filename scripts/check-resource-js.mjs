import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESOURCE_DIR = path.join(ROOT, 'apps', 'windows-client', 'resources');

function toPosix(filePath) {
  return filePath.split(path.sep).join('/');
}

function rel(filePath) {
  return toPosix(path.relative(ROOT, filePath));
}

function listResourceScripts() {
  return fs
    .readdirSync(RESOURCE_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
    .map((entry) => path.join(RESOURCE_DIR, entry.name))
    .sort((a, b) => rel(a).localeCompare(rel(b)));
}

function assertClassicScriptSyntax(filePath) {
  const source = fs.readFileSync(filePath, 'utf8');
  try {
    // These files are loaded by index.html as classic scripts, so parse them
    // with the same non-module boundary before the TS migration removes them.
    new vm.Script(source, { filename: filePath, displayErrors: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${rel(filePath)}: ${message}`);
  }
}

const scripts = listResourceScripts();

if (scripts.length === 0) {
  console.error(`Resource JS check failed: no scripts found in ${rel(RESOURCE_DIR)}.`);
  process.exit(1);
}

try {
  for (const script of scripts) {
    assertClassicScriptSyntax(script);
  }
} catch (error) {
  console.error('Resource JS syntax check failed:');
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

console.log(`Resource JS syntax check passed (${scripts.length} files).`);
