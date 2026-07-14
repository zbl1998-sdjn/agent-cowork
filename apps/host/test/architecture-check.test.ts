import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const runHostNodeScript = path.join(repoRoot, 'scripts', 'run-host-node.mjs');
const checkArchScript = path.join(repoRoot, 'scripts', 'check-arch.ts');
const nodeExecutable = process.execPath ?? 'node';

function writeFile(filePath: string, text: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text);
}

test('architecture check includes host .ts sources and resolves .js specifiers to .ts files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-arch-ts-'));
  fs.mkdirSync(path.join(root, 'apps', 'windows-client', 'ui', 'src'), { recursive: true });

  writeFile(
    path.join(root, 'apps', 'host', 'src', 'tools', 'bad.ts'),
    "import '../routes/later.js';\nexport const value = 1;\n",
  );
  writeFile(path.join(root, 'apps', 'host', 'src', 'routes', 'later.ts'), 'export const later = 1;\n');

  const result = spawnSync(nodeExecutable, [runHostNodeScript, checkArchScript], {
    cwd: repoRoot,
    env: { ...process.env, KCW_ARCH_CHECK_ROOT: root },
    encoding: 'utf8',
  });
  const output = String(result.stdout ?? '') + String(result.stderr ?? '');

  assert.ok(result.status !== 0, output);
  assert.match(output, /Architecture check failed:/);
  assert.match(
    output,
    /apps\/host\/src\/tools\/bad\.ts \(L1\) imports apps\/host\/src\/routes\/later\.ts \(L3\)/,
  );
});

test('host architecture has no layer waivers and rejects every former reverse dependency', () => {
  const checkSource = fs.readFileSync(checkArchScript, 'utf8');
  assert.doesNotMatch(checkSource, /HOST_LAYER_WAIVERS|waiverRel/);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-arch-no-waivers-'));
  fs.mkdirSync(path.join(root, 'apps', 'windows-client', 'ui', 'src'), { recursive: true });

  writeFile(
    path.join(root, 'apps', 'host', 'src', 'engine', 'agent', 'model-resilience.js'),
    "import { modelBreaker } from '../../runtime/model-breakers.js';\nexport const breaker = modelBreaker;\n",
  );
  writeFile(
    path.join(root, 'apps', 'host', 'src', 'engine', 'chat-stream.js'),
    [
      "import { writeRunRecord } from '../runtime/run-store.js';",
      "import { RunsIndex } from '../runtime/runs-index.js';",
      'export const chatDeps = [writeRunRecord, RunsIndex];',
      '',
    ].join('\n'),
  );
  writeFile(
    path.join(root, 'apps', 'host', 'src', 'recipes', 'run-recipe.js'),
    [
      "import { writeRunRecord } from '../runtime/run-store.js';",
      "import { RunsIndex } from '../runtime/runs-index.js';",
      'export const recipeDeps = [writeRunRecord, RunsIndex];',
      '',
    ].join('\n'),
  );
  writeFile(
    path.join(root, 'apps', 'host', 'src', 'sandbox', 'code-runner.js'),
    [
      "import { writeRunRecord } from '../runtime/run-store.js';",
      "import { RunsIndex } from '../runtime/runs-index.js';",
      'export const sandboxDeps = [writeRunRecord, RunsIndex];',
      '',
    ].join('\n'),
  );
  writeFile(
    path.join(root, 'apps', 'host', 'src', 'storage', 'postgres-event-bus.js'),
    "import { RunEventBus } from '../runtime/run-events.js';\nexport const eventBus = RunEventBus;\n",
  );
  writeFile(
    path.join(root, 'apps', 'host', 'src', 'runtime', 'model-breakers.ts'),
    'export function modelBreaker() { return null; }\n',
  );
  writeFile(
    path.join(root, 'apps', 'host', 'src', 'runtime', 'run-store.ts'),
    'export function writeRunRecord() { return null; }\n',
  );
  writeFile(
    path.join(root, 'apps', 'host', 'src', 'runtime', 'runs-index.ts'),
    'export class RunsIndex {}\n',
  );
  writeFile(
    path.join(root, 'apps', 'host', 'src', 'runtime', 'run-events.ts'),
    'export class RunEventBus {}\n',
  );

  const result = spawnSync(nodeExecutable, [runHostNodeScript, checkArchScript], {
    cwd: repoRoot,
    env: { ...process.env, KCW_ARCH_CHECK_ROOT: root },
    encoding: 'utf8',
  });
  const output = String(result.stdout ?? '') + String(result.stderr ?? '');

  assert.ok(result.status !== 0, output);
  const formerEdges = [
    'engine/agent/model-resilience.js (L1) imports apps/host/src/runtime/model-breakers.ts (L2)',
    'engine/chat-stream.js (L1) imports apps/host/src/runtime/run-store.ts (L2)',
    'engine/chat-stream.js (L1) imports apps/host/src/runtime/runs-index.ts (L2)',
    'recipes/run-recipe.js (L1) imports apps/host/src/runtime/run-store.ts (L2)',
    'recipes/run-recipe.js (L1) imports apps/host/src/runtime/runs-index.ts (L2)',
    'sandbox/code-runner.js (L1) imports apps/host/src/runtime/run-store.ts (L2)',
    'sandbox/code-runner.js (L1) imports apps/host/src/runtime/runs-index.ts (L2)',
    'storage/postgres-event-bus.js (L1) imports apps/host/src/runtime/run-events.ts (L2)',
  ];
  for (const edge of formerEdges) {
    assert.ok(output.includes(edge), `missing former edge violation: ${edge}\n${output}`);
  }
});

test('architecture check fails closed when a host source is not assigned to a layer', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-arch-unassigned-'));
  fs.mkdirSync(path.join(root, 'apps', 'windows-client', 'ui', 'src'), { recursive: true });

  writeFile(
    path.join(root, 'apps', 'host', 'src', 'unclassified', 'orphan.ts'),
    'export const orphan = true;\n',
  );

  const result = spawnSync(nodeExecutable, [runHostNodeScript, checkArchScript], {
    cwd: repoRoot,
    env: { ...process.env, KCW_ARCH_CHECK_ROOT: root },
    encoding: 'utf8',
  });
  const output = String(result.stdout ?? '') + String(result.stderr ?? '');

  assert.ok(result.status !== 0, output);
  assert.match(output, /apps\/host\/src\/unclassified\/orphan\.ts is not assigned to a host architecture layer/);
});

test('architecture check classifies onboarding as L1 domain code', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-arch-onboarding-'));
  fs.mkdirSync(path.join(root, 'apps', 'windows-client', 'ui', 'src'), { recursive: true });

  writeFile(
    path.join(root, 'apps', 'host', 'src', 'onboarding', 'bad.ts'),
    "import '../routes/later.js';\nexport const value = 1;\n",
  );
  writeFile(path.join(root, 'apps', 'host', 'src', 'routes', 'later.ts'), 'export const later = 1;\n');

  const result = spawnSync(nodeExecutable, [runHostNodeScript, checkArchScript], {
    cwd: repoRoot,
    env: { ...process.env, KCW_ARCH_CHECK_ROOT: root },
    encoding: 'utf8',
  });
  const output = String(result.stdout ?? '') + String(result.stderr ?? '');

  assert.ok(result.status !== 0, output);
  assert.match(
    output,
    /apps\/host\/src\/onboarding\/bad\.ts \(L1\) imports apps\/host\/src\/routes\/later\.ts \(L3\)/,
  );
});

test('architecture check rejects UI transport importing the component layer', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-arch-ui-reverse-'));
  writeFile(path.join(root, 'apps', 'host', 'src', 'security', 'empty.ts'), 'export const empty = true;\n');

  writeFile(
    path.join(root, 'apps', 'windows-client', 'ui', 'src', 'lib', 'api', 'bad.ts'),
    "import { Button } from '../../components/Button';\nexport const value = Button;\n",
  );
  writeFile(
    path.join(root, 'apps', 'windows-client', 'ui', 'src', 'components', 'Button.tsx'),
    'export function Button() { return null; }\n',
  );

  const result = spawnSync(nodeExecutable, [runHostNodeScript, checkArchScript], {
    cwd: repoRoot,
    env: { ...process.env, KCW_ARCH_CHECK_ROOT: root },
    encoding: 'utf8',
  });
  const output = String(result.stdout ?? '') + String(result.stderr ?? '');

  assert.ok(result.status !== 0, output);
  assert.match(
    output,
    /apps\/windows-client\/ui\/src\/lib\/api\/bad\.ts \(UI-L0\) imports apps\/windows-client\/ui\/src\/components\/Button\.tsx \(UI-L2\)/,
  );
});

test('architecture check fails closed when a UI source is not assigned to a layer', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-arch-ui-unassigned-'));
  writeFile(path.join(root, 'apps', 'host', 'src', 'security', 'empty.ts'), 'export const empty = true;\n');
  writeFile(
    path.join(root, 'apps', 'windows-client', 'ui', 'src', 'features', 'orphan.ts'),
    'export const orphan = true;\n',
  );

  const result = spawnSync(nodeExecutable, [runHostNodeScript, checkArchScript], {
    cwd: repoRoot,
    env: { ...process.env, KCW_ARCH_CHECK_ROOT: root },
    encoding: 'utf8',
  });
  const output = String(result.stdout ?? '') + String(result.stderr ?? '');

  assert.ok(result.status !== 0, output);
  assert.match(
    output,
    /apps\/windows-client\/ui\/src\/features\/orphan\.ts is not assigned to a UI architecture layer/,
  );
});

test('architecture check detects parser-supported dynamic module syntax', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-arch-dynamic-parser-'));
  fs.mkdirSync(path.join(root, 'apps', 'windows-client', 'ui', 'src'), { recursive: true });

  writeFile(
    path.join(root, 'apps', 'host', 'src', 'tools', 'bad.ts'),
    [
      'export async function loadLater() {',
      '  return import(',
      '    /* comments are scanner trivia, not parser boundaries */',
      "    '../routes/later.js',",
      "    { with: { type: 'json' } },",
      '  );',
      '}',
      '',
    ].join('\n'),
  );
  writeFile(path.join(root, 'apps', 'host', 'src', 'routes', 'later.ts'), 'export const later = 1;\n');

  const result = spawnSync(nodeExecutable, [runHostNodeScript, checkArchScript], {
    cwd: repoRoot,
    env: { ...process.env, KCW_ARCH_CHECK_ROOT: root },
    encoding: 'utf8',
  });
  const output = String(result.stdout ?? '') + String(result.stderr ?? '');

  assert.ok(result.status !== 0, output);
  assert.match(
    output,
    /apps\/host\/src\/tools\/bad\.ts \(L1\) imports apps\/host\/src\/routes\/later\.ts \(L3\)/,
  );
});

test('architecture check detects multiline export-from syntax', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-arch-multiline-parser-'));
  fs.mkdirSync(path.join(root, 'apps', 'windows-client', 'ui', 'src'), { recursive: true });

  writeFile(
    path.join(root, 'apps', 'host', 'src', 'tools', 'bad.ts'),
    [
      'export {',
      '  later,',
      '} from',
      "  '../routes/later.js';",
      '',
    ].join('\n'),
  );
  writeFile(path.join(root, 'apps', 'host', 'src', 'routes', 'later.ts'), 'export const later = 1;\n');

  const result = spawnSync(nodeExecutable, [runHostNodeScript, checkArchScript], {
    cwd: repoRoot,
    env: { ...process.env, KCW_ARCH_CHECK_ROOT: root },
    encoding: 'utf8',
  });
  const output = String(result.stdout ?? '') + String(result.stderr ?? '');

  assert.ok(result.status !== 0, output);
  assert.match(
    output,
    /apps\/host\/src\/tools\/bad\.ts \(L1\) imports apps\/host\/src\/routes\/later\.ts \(L3\)/,
  );
});

test('architecture check detects template-literal dynamic import syntax', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-arch-template-parser-'));
  fs.mkdirSync(path.join(root, 'apps', 'windows-client', 'ui', 'src'), { recursive: true });

  writeFile(
    path.join(root, 'apps', 'host', 'src', 'tools', 'bad.ts'),
    'export const lazy = () => import(`../routes/later.js`);\n',
  );
  writeFile(path.join(root, 'apps', 'host', 'src', 'routes', 'later.ts'), 'export const later = 1;\n');

  const result = spawnSync(nodeExecutable, [runHostNodeScript, checkArchScript], {
    cwd: repoRoot,
    env: { ...process.env, KCW_ARCH_CHECK_ROOT: root },
    encoding: 'utf8',
  });
  const output = String(result.stdout ?? '') + String(result.stderr ?? '');

  assert.ok(result.status !== 0, output);
  assert.match(
    output,
    /apps\/host\/src\/tools\/bad\.ts \(L1\) imports apps\/host\/src\/routes\/later\.ts \(L3\)/,
  );
});

test('architecture check ignores import-like text in comments and literals', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-arch-parser-trivia-'));
  fs.mkdirSync(path.join(root, 'apps', 'windows-client', 'ui', 'src'), { recursive: true });

  writeFile(
    path.join(root, 'apps', 'host', 'src', 'tools', 'safe.ts'),
    [
      "// import('../routes/later.js');",
      "/* require('../routes/later.js'); */",
      "export const text = \"import('../routes/later.js')\";",
      "export const pattern = /require\\('../routes\\/later\\.js'\\)/;",
      "export const template = `export { later } from '../routes/later.js'`;",
      '',
    ].join('\n'),
  );
  writeFile(path.join(root, 'apps', 'host', 'src', 'routes', 'later.ts'), 'export const later = 1;\n');

  const result = spawnSync(nodeExecutable, [runHostNodeScript, checkArchScript], {
    cwd: repoRoot,
    env: { ...process.env, KCW_ARCH_CHECK_ROOT: root },
    encoding: 'utf8',
  });
  const output = String(result.stdout ?? '') + String(result.stderr ?? '');

  assert.equal(result.status, 0, output);
});
