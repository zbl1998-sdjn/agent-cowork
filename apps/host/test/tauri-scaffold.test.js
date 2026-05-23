import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const appsRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const workspaceRoot = path.dirname(appsRoot);
const tauriRoot = path.join(appsRoot, 'windows-client', 'src-tauri');
const resourcesRoot = path.join(appsRoot, 'windows-client', 'resources');
const packageJson = JSON.parse(fs.readFileSync(path.join(workspaceRoot, 'package.json'), 'utf8'));

test('Tauri scaffold keeps npm zero-deps and points at the Node host/static resources', () => {
  assert.equal(Object.keys(packageJson.dependencies || {}).length, 0);
  assert.equal(Object.keys(packageJson.devDependencies || {}).length, 0);

  const config = JSON.parse(fs.readFileSync(path.join(tauriRoot, 'tauri.conf.json'), 'utf8'));
  assert.equal(config.productName, 'Agent Cowork');
  assert.equal(config.build.devUrl, 'http://127.0.0.1:5173');
  assert.equal(config.build.frontendDist, '../ui-dist');
  assert.equal(config.app.windows[0].label, 'main');
  assert.ok(config.app.security.csp, 'Tauri CSP must not be null');
  assert.equal(config.bundle.active, true);
  assert.deepEqual(config.bundle.externalBin, ['binaries/kimi-cowork-host']);
});

test('Tauri scaffold exposes sidecar, safe opener and notification integration points', () => {
  const cargoToml = fs.readFileSync(path.join(tauriRoot, 'Cargo.toml'), 'utf8');
  assert.match(cargoToml, /tauri\s*=/);
  assert.match(cargoToml, /tauri-plugin-shell/);
  assert.match(cargoToml, /tauri-plugin-opener/);
  assert.match(cargoToml, /tauri-plugin-notification/);

  // The shell is modular: integration points live across src/*.rs, so scan the
  // whole crate source rather than assuming everything sits in lib.rs.
  const srcDir = path.join(tauriRoot, 'src');
  const rust = fs
    .readdirSync(srcDir)
    .filter((name) => name.endsWith('.rs'))
    .map((name) => fs.readFileSync(path.join(srcDir, name), 'utf8'))
    .join('\n');
  for (const symbol of [
    'start_node_host',
    'host_status',
    'open_path',
    '.sidecar(',
    'binaries/kimi-cowork-host',
    'tauri_plugin_shell::init()',
    'tauri_plugin_opener::init()',
    'tauri_plugin_notification::init()',
    'assert_trusted_path',
  ]) {
    assert.ok(rust.includes(symbol), `missing ${symbol}`);
  }
  assert.equal(rust.includes('Command::new("node")'), false, 'packaged Tauri app must use sidecar instead of PATH node');

  const capability = JSON.parse(fs.readFileSync(path.join(tauriRoot, 'capabilities', 'default.json'), 'utf8'));
  // Hardened: the broad opener:default / shell:allow-open / shell:default grants
  // are intentionally NOT present (they would let the webview open arbitrary
  // paths/URLs or shell out). The "safe opener" is the custom open_path command
  // above, which validates against the trusted root via assert_trusted_path.
  assert.equal(capability.permissions.includes('opener:default'), false);
  assert.equal(capability.permissions.includes('shell:default'), false);
  assert.equal(capability.permissions.includes('shell:allow-open'), false);
  assert.ok(capability.permissions.some((permission) => (
    permission.identifier === 'shell:allow-execute'
    && permission.allow?.some((item) => item.name === 'binaries/kimi-cowork-host' && item.sidecar === true)
  )));
});

test('component manifest covers the React rewrite component contract', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(resourcesRoot, 'component-manifest.json'), 'utf8'));
  const names = new Set(manifest.components.map((component) => component.name));
  for (const name of [
    'MessageBubble',
    'ClarificationCard',
    'ProgressLine',
    'PreviewCard',
    'ApprovalActions',
    'ArtifactCard',
    'SourcesFooter',
    'Composer',
    'TaskStatusBadge',
  ]) {
    assert.ok(names.has(name), `missing ${name}`);
  }
});
