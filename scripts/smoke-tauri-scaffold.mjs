import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tauriRoot = path.join(repoRoot, 'apps', 'windows-client', 'src-tauri');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function commandAvailable(command, args = ['--version']) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true });
  return {
    ok: result.status === 0,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
  };
}

const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
assert(!packageJson.dependencies || Object.keys(packageJson.dependencies).length === 0, 'package.json must stay zero runtime dependencies');
assert(!packageJson.devDependencies || Object.keys(packageJson.devDependencies).length === 0, 'package.json must stay zero dev dependencies');

const configPath = path.join(tauriRoot, 'tauri.conf.json');
const cargoPath = path.join(tauriRoot, 'Cargo.toml');
const libPath = path.join(tauriRoot, 'src', 'lib.rs');
const capabilityPath = path.join(tauriRoot, 'capabilities', 'default.json');
const manifestPath = path.join(repoRoot, 'apps', 'windows-client', 'resources', 'component-manifest.json');

assert(fs.existsSync(configPath), 'missing Tauri config');
assert(fs.existsSync(cargoPath), 'missing Tauri Cargo.toml');
assert(fs.existsSync(libPath), 'missing Tauri Rust entry');
assert(fs.existsSync(capabilityPath), 'missing Tauri default capability');
assert(fs.existsSync(manifestPath), 'missing component migration manifest');

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
assert(config.productName === 'Agent Cowork', 'Tauri product name mismatch');
assert(config.build?.devUrl === 'http://127.0.0.1:3017', 'Tauri devUrl must target the Node host');
assert(config.build?.frontendDist === '../resources', 'Tauri frontendDist must reuse static resources');
assert(config.app?.windows?.[0]?.label === 'main', 'Tauri main window label missing');
assert(Boolean(config.app?.security?.csp), 'Tauri CSP must not be null');
assert(config.bundle?.active === true, 'Tauri bundle must be active');
assert(JSON.stringify(config.bundle?.externalBin || []) === JSON.stringify(['binaries/kimi-cowork-host']), 'Tauri bundle must declare host sidecar');

const cargoToml = fs.readFileSync(cargoPath, 'utf8');
for (const crate of ['tauri =', 'tauri-plugin-shell', 'tauri-plugin-opener', 'tauri-plugin-notification']) {
  assert(cargoToml.includes(crate), `Cargo.toml missing ${crate}`);
}

const lib = fs.readFileSync(libPath, 'utf8');
for (const symbol of [
  'start_node_host',
  'host_status',
  'open_path',
  '.sidecar("binaries/kimi-cowork-host")',
  'assert_trusted_path',
  'tauri_plugin_shell::init()',
  'tauri_plugin_opener::init()',
  'tauri_plugin_notification::init()',
]) {
  assert(lib.includes(symbol), `Tauri Rust entry missing ${symbol}`);
}
assert(!lib.includes('Command::new("node")'), 'Tauri Rust entry must use packaged sidecar instead of PATH node');

const capability = JSON.parse(fs.readFileSync(capabilityPath, 'utf8'));
assert((capability.permissions || []).includes('opener:default'), 'Tauri capability must include opener:default');
assert(!(capability.permissions || []).includes('shell:allow-open'), 'Tauri capability must not grant broad shell open');
assert((capability.permissions || []).some((permission) => (
  permission?.identifier === 'shell:allow-execute'
  && (permission.allow || []).some((item) => item.name === 'binaries/kimi-cowork-host' && item.sidecar === true)
)), 'Tauri capability must allow only the packaged host sidecar');

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const requiredComponents = [
  'MessageBubble',
  'ClarificationCard',
  'ProgressLine',
  'PreviewCard',
  'ApprovalActions',
  'ArtifactCard',
  'SourcesFooter',
  'Composer',
  'TaskStatusBadge',
];
const names = new Set((manifest.components || []).map((component) => component.name));
for (const name of requiredComponents) {
  assert(names.has(name), `component manifest missing ${name}`);
}

const cargo = commandAvailable('cargo');
const rustc = commandAvailable('rustc');
const tauri = commandAvailable('cargo', ['tauri', '--version']);
console.log(JSON.stringify({
  ok: true,
  tauriRoot,
  packageDependencies: 0,
  requiredComponents: requiredComponents.length,
  toolchain: {
    cargo,
    rustc,
    tauri,
    runnable: cargo.ok && rustc.ok && tauri.ok,
  },
}, null, 2));
