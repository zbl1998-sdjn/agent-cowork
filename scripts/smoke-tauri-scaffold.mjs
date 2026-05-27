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
const embeddedPythonScriptPath = path.join(repoRoot, 'scripts', 'prepare-embedded-python.ps1');

assert(fs.existsSync(configPath), 'missing Tauri config');
assert(fs.existsSync(cargoPath), 'missing Tauri Cargo.toml');
assert(fs.existsSync(libPath), 'missing Tauri Rust entry');
assert(fs.existsSync(capabilityPath), 'missing Tauri default capability');
assert(fs.existsSync(manifestPath), 'missing component migration manifest');
assert(fs.existsSync(embeddedPythonScriptPath), 'missing embedded Python staging script');

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
assert(config.productName === 'Agent Cowork', 'Tauri product name mismatch');
assert(config.build?.devUrl === 'http://127.0.0.1:5173', 'Tauri devUrl must target the Vite dev server');
assert(config.build?.frontendDist === '../ui-dist', 'Tauri frontendDist must use the built React UI');
assert((config.build?.beforeBuildCommand || '').includes('prepare-embedded-python.ps1'), 'Tauri build must stage embedded Python before bundling');
assert(config.app?.windows?.[0]?.label === 'main', 'Tauri main window label missing');
assert(Boolean(config.app?.security?.csp), 'Tauri CSP must not be null');
assert(config.bundle?.active === true, 'Tauri bundle must be active');
assert(config.bundle?.createUpdaterArtifacts === true, 'Tauri updater artifacts must be enabled');
assert(config.bundle?.useLocalToolsDir === true, 'Tauri bundler tools must stay in target/.tauri for reproducible local builds');
assert(config.bundle?.resources?.['../resources/python-embedded'] === 'python-embedded', 'Tauri bundle must package embedded Python resources');
assert(JSON.stringify(config.bundle?.externalBin || []) === JSON.stringify(['binaries/agent-cowork-host']), 'Tauri bundle must declare host sidecar');
assert(config.plugins?.updater?.pubkey, 'Tauri updater pubkey missing');
const updaterEndpoints = config.plugins?.updater?.endpoints || [];
assert(updaterEndpoints.includes('https://updates.agent-cowork.local/desktop-update/{{target}}/{{arch}}/{{current_version}}'), 'Tauri updater endpoint missing');
for (const endpoint of updaterEndpoints) {
  assert(endpoint.startsWith('https://'), 'Tauri updater endpoints must use HTTPS in release builds');
}

const embeddedPythonScript = fs.readFileSync(embeddedPythonScriptPath, 'utf8');
for (const token of [
  'python-$Version-embeddable-$Arch.zip',
  '3.12.10',
  '156c7eea90d58cd7e91a23f28a0056616b13e9f4cf4901b7b99b837b7848c6da',
  'Get-FileHash',
  'Expand-Archive',
  'PYTHON_EMBEDDED_MANIFEST.json',
]) {
  assert(embeddedPythonScript.includes(token), `embedded Python staging script missing ${token}`);
}

const cargoToml = fs.readFileSync(cargoPath, 'utf8');
for (const crate of ['tauri =', 'tauri-plugin-shell', 'tauri-plugin-opener', 'tauri-plugin-notification', 'tauri-plugin-updater']) {
  assert(cargoToml.includes(crate), `Cargo.toml missing ${crate}`);
}

const lib = fs
  .readdirSync(path.join(tauriRoot, 'src'))
  .filter((name) => name.endsWith('.rs'))
  .map((name) => fs.readFileSync(path.join(tauriRoot, 'src', name), 'utf8'))
  .join('\n');
for (const symbol of [
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
  'assert_trusted_path',
  'tauri_plugin_shell::init()',
  'tauri_plugin_opener::init()',
  'tauri_plugin_notification::init()',
  'tauri_plugin_updater::Builder',
]) {
  assert(lib.includes(symbol), `Tauri Rust entry missing ${symbol}`);
}
assert(!lib.includes('Command::new("node")'), 'Tauri Rust entry must use packaged sidecar instead of PATH node');

const capability = JSON.parse(fs.readFileSync(capabilityPath, 'utf8'));
assert(!(capability.permissions || []).includes('opener:default'), 'Tauri capability must not include broad opener:default');
assert(!(capability.permissions || []).includes('shell:allow-open'), 'Tauri capability must not grant broad shell open');
assert((capability.permissions || []).some((permission) => (
  permission?.identifier === 'shell:allow-execute'
  && (permission.allow || []).some((item) => item.name === 'binaries/agent-cowork-host' && item.sidecar === true)
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
