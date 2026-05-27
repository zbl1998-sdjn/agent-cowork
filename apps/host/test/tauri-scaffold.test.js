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
  assert.equal(config.bundle.createUpdaterArtifacts, true);
  assert.deepEqual(config.bundle.targets, ['nsis']);
  assert.deepEqual(config.bundle.windows.webviewInstallMode, { type: 'embedBootstrapper' });
  assert.equal(config.bundle.windows.nsis.installMode, 'currentUser');
  assert.deepEqual(config.bundle.externalBin, ['binaries/agent-cowork-host']);
  assert.ok(config.plugins?.updater?.pubkey, 'Tauri updater pubkey must be configured');
  assert.deepEqual(config.plugins.updater.endpoints, [
    'https://updates.agent-cowork.local/desktop-update/{{target}}/{{arch}}/{{current_version}}',
  ]);
  for (const endpoint of config.plugins.updater.endpoints) {
    assert.ok(endpoint.startsWith('https://'), 'release updater endpoints must use HTTPS');
  }
});

test('Tauri scaffold exposes sidecar, safe opener and notification integration points', () => {
  const cargoToml = fs.readFileSync(path.join(tauriRoot, 'Cargo.toml'), 'utf8');
  assert.match(cargoToml, /tauri\s*=/);
  assert.match(cargoToml, /tauri-plugin-shell/);
  assert.match(cargoToml, /tauri-plugin-opener/);
  assert.match(cargoToml, /tauri-plugin-notification/);
  assert.match(cargoToml, /tauri-plugin-updater/);

  // Integration points live across src/*.rs, so scan the whole crate source.
  const srcDir = path.join(tauriRoot, 'src');
  const rust = fs
    .readdirSync(srcDir)
    .filter((name) => name.endsWith('.rs'))
    .map((name) => fs.readFileSync(path.join(srcDir, name), 'utf8'))
    .join('\n');
  // The bundled Node host is spawned directly via std::process::Command from the
  // binary next to the desktop exe (resolved with current_exe). The Tauri shell
  // sidecar helper spawned unreliably in packaged builds, so we no longer use it;
  // the host is also started natively in the setup hook, not only via invoke.
  const requiredSymbols = [
    'start_node_host',
    'host_status',
    'open_path',
    'check_desktop_update',
    'install_desktop_update',
    'agent-cowork-host',
    'Command::new',
    'current_exe',
    '.setup',
    'tauri_plugin_opener::init',
    'tauri_plugin_notification::init',
    'tauri_plugin_updater::Builder',
    'assert_trusted_path',
    'assert_openable_path',
    'hidden or sensitive path blocked',
  ];
  for (const symbol of requiredSymbols) {
    assert.ok(rust.includes(symbol), `missing ${symbol}`);
  }
  // The packaged app must spawn the bundled host binary, never a PATH node.
  assert.equal(rust.includes('Command::new("node")'), false, 'must not spawn PATH node');

  const capability = JSON.parse(fs.readFileSync(path.join(tauriRoot, 'capabilities', 'default.json'), 'utf8'));
  // Hardened: broad opener:default / shell:allow-open / shell:default grants are
  // intentionally absent; the safe opener is the custom open_path command above.
  assert.equal(capability.permissions.includes('opener:default'), false);
  assert.equal(capability.permissions.includes('shell:default'), false);
  assert.equal(capability.permissions.includes('shell:allow-open'), false);
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
