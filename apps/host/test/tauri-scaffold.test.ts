import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const appsRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const workspaceRoot = path.dirname(appsRoot);
const tauriRoot = path.join(appsRoot, 'windows-client', 'src-tauri');
const resourcesRoot = path.join(appsRoot, 'windows-client', 'resources');
const packageJson = recordValue(JSON.parse(fs.readFileSync(path.join(workspaceRoot, 'package.json'), 'utf8')) as unknown, 'package.json');

function recordValue(value: unknown, label: string): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} should be an object`);
  return value as Record<string, unknown>;
}

function recordArray(value: unknown, label: string): Array<Record<string, unknown>> {
  assert.ok(Array.isArray(value), `${label} should be an array`);
  return value.map((item, index) => recordValue(item, `${label}[${index}]`));
}

function stringArray(value: unknown, label: string): string[] {
  assert.ok(Array.isArray(value), `${label} should be an array`);
  return value.map((item, index) => {
    assert.equal(typeof item, 'string', `${label}[${index}] should be a string`);
    return item;
  });
}

function permissionIds(value: unknown): string[] {
  assert.ok(Array.isArray(value), 'tauri capability permissions should be an array');
  return value.map((permission, index) => {
    if (typeof permission === 'string') return permission;
    return String(recordValue(permission, `tauri capability permissions[${index}]`).identifier || '');
  });
}

test('Tauri scaffold keeps host npm dependencies allowlisted and points at the Node host/static resources', () => {
  assert.deepEqual(Object.keys(recordValue(packageJson.dependencies, 'package dependencies')).sort(), ['zod']);
  assert.deepEqual(Object.keys(recordValue(packageJson.devDependencies, 'package devDependencies')).sort(), [
    '@eslint/js',
    'eslint',
    'eslint-plugin-react-hooks',
    'typescript',
    'typescript-eslint',
  ]);

  const config = recordValue(JSON.parse(fs.readFileSync(path.join(tauriRoot, 'tauri.conf.json'), 'utf8')) as unknown, 'tauri config');
  assert.equal(config.productName, 'Agent Cowork');
  const build = recordValue(config.build, 'tauri build config');
  assert.equal(build.devUrl, 'http://127.0.0.1:5173');
  assert.equal(build.frontendDist, '../ui-dist');
  assert.match(String(build.beforeBuildCommand), /prepare-embedded-python\.ps1/);
  const app = recordValue(config.app, 'tauri app config');
  assert.equal(recordArray(app.windows, 'tauri windows')[0]?.label, 'main');
  assert.ok(recordValue(app.security, 'tauri security config').csp, 'Tauri CSP must not be null');
  const bundle = recordValue(config.bundle, 'tauri bundle config');
  assert.equal(bundle.active, true);
  assert.equal(bundle.createUpdaterArtifacts, true);
  assert.equal(bundle.useLocalToolsDir, true);
  assert.deepEqual(bundle.targets, ['nsis']);
  const bundleWindows = recordValue(bundle.windows, 'tauri bundle windows config');
  assert.deepEqual(bundleWindows.webviewInstallMode, { type: 'embedBootstrapper' });
  assert.equal(recordValue(bundleWindows.nsis, 'tauri nsis config').installMode, 'currentUser');
  assert.deepEqual(bundle.resources, {
    '../resources/python-embedded': 'python-embedded',
  });
  assert.deepEqual(bundle.externalBin, ['binaries/agent-cowork-host']);
  const updater = recordValue(recordValue(config.plugins, 'tauri plugins').updater, 'tauri updater config');
  assert.ok(updater.pubkey, 'Tauri updater pubkey must be configured');
  assert.deepEqual(updater.endpoints, [
    'https://updates.agent-cowork.local/desktop-update/{{target}}/{{arch}}/{{current_version}}',
  ]);
  for (const endpoint of stringArray(updater.endpoints, 'tauri updater endpoints')) {
    assert.ok(endpoint.startsWith('https://'), 'release updater endpoints must use HTTPS');
  }
});

test('embedded Python staging script pins the official embeddable archive and verifies SHA256', () => {
  const script = fs.readFileSync(path.join(workspaceRoot, 'scripts', 'prepare-embedded-python.ps1'), 'utf8');
  assert.match(script, /python-\$Version-embeddable-\$Arch\.zip/);
  assert.match(script, /3\.12\.10/);
  assert.match(script, /156c7eea90d58cd7e91a23f28a0056616b13e9f4cf4901b7b99b837b7848c6da/);
  assert.match(script, /Get-FileHash/);
  assert.match(script, /Expand-Archive/);
  assert.match(script, /PYTHON_EMBEDDED_MANIFEST\.json/);
  assert.match(script, /Lib\\site-packages/);
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
    'KCW_PYTHON_HOME',
    'KCW_EMBEDDED_PYTHON',
    'resource_dir',
    'python-embedded',
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

  const capability = recordValue(JSON.parse(fs.readFileSync(path.join(tauriRoot, 'capabilities', 'default.json'), 'utf8')) as unknown, 'tauri default capability');
  // Hardened: broad opener:default / shell:allow-open / shell:default grants are
  // intentionally absent; the safe opener is the custom open_path command above.
  const permissions = permissionIds(capability.permissions);
  assert.equal(permissions.includes('opener:default'), false);
  assert.equal(permissions.includes('shell:default'), false);
  assert.equal(permissions.includes('shell:allow-open'), false);
});

test('component manifest covers the React rewrite component contract', () => {
  const manifest = recordValue(JSON.parse(fs.readFileSync(path.join(resourcesRoot, 'component-manifest.json'), 'utf8')) as unknown, 'component manifest');
  const names = new Set(recordArray(manifest.components, 'component manifest entries').map((component) => String(component.name)));
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
