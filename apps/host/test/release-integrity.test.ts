import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertChangelogVersion,
  assertInstallerVersions,
  assertReleaseVersions,
  cleanCanonicalBundleRoot,
  createArtifactEvidence,
  createReleaseManifest,
  selectUpdaterArtifacts,
} from '../../../scripts/release-integrity.js';

test('release integrity rejects installers that do not match the target version', () => {
  assert.throws(
    () => assertInstallerVersions([], '0.3.1'),
    /canonical installer/i,
  );
  assert.throws(
    () => assertInstallerVersions([
      'installers/Agent Cowork_0.3.0_x64-setup.exe',
    ], '0.3.1'),
    /target version 0\.3\.1/,
  );

  assert.doesNotThrow(() => assertInstallerVersions([
    'installers/Agent Cowork_0.3.1_x64-setup.exe',
    'installers/Agent-Cowork-Setup-v0.3.1.msi',
  ], '0.3.1'));

  assert.throws(
    () => assertInstallerVersions([
      'installers/Agent-Cowork-Setup-v0.3.1-internal-beta.msi',
    ], '0.3.1'),
    /target version 0\.3\.1/,
  );
  assert.throws(
    () => assertInstallerVersions([
      'installers/Agent-Cowork_0.3.1_from_0.3.0.exe',
    ], '0.3.1'),
    /target version 0\.3\.1/,
  );
});

test('release integrity rejects project manifest version drift before artifacts are considered', () => {
  assert.doesNotThrow(() => assertReleaseVersions({
    root: '0.3.1',
    ui: '0.3.1',
    cargo: '0.3.1',
    tauri: '0.3.1',
  }, '0.3.1'));
  assert.throws(() => assertReleaseVersions({
    root: '0.3.1',
    ui: '0.3.0',
    cargo: '0.3.1',
    tauri: '0.3.1',
  }, '0.3.1'), /ui version 0\.3\.0 does not match target version 0\.3\.1/);
});

test('release integrity requires an exact CHANGELOG release heading', () => {
  assert.doesNotThrow(() => assertChangelogVersion([
    '# Changelog',
    '',
    '## [Unreleased]',
    '',
    '## [0.3.1] - 2026-07-10',
  ].join('\n'), '0.3.1'));
  assert.throws(
    () => assertChangelogVersion('## [0.3.10] - 2026-07-10\nmentions 0.3.1 only in prose', '0.3.1'),
    /CHANGELOG\.md.*0\.3\.1/i,
  );
  assert.throws(
    () => assertChangelogVersion('## [0.3.1-rc.1] - 2026-07-10', '0.3.1'),
    /CHANGELOG\.md.*0\.3\.1/i,
  );
});

test('release integrity selects updater artifacts for the exact target version only', () => {
  const paths = [
    'bundle/nsis/Agent Cowork_0.3.0_x64-setup.nsis.zip',
    'bundle/nsis/Agent Cowork_0.3.0_x64-setup.nsis.zip.sig',
    'bundle/nsis/Agent Cowork_0.3.1_x64-setup.nsis.zip',
    'bundle/nsis/Agent Cowork_0.3.1_x64-setup.nsis.zip.sig',
    'bundle/nsis/Agent Cowork_0.3.1-rc.1_x64-setup.nsis.zip',
    'bundle/nsis/Agent Cowork_10.3.1_x64-setup.nsis.zip.sig',
  ];

  assert.deepEqual(selectUpdaterArtifacts(paths, '0.3.1'), [
    'bundle/nsis/Agent Cowork_0.3.1_x64-setup.nsis.zip',
    'bundle/nsis/Agent Cowork_0.3.1_x64-setup.nsis.zip.sig',
  ]);
});

test('canonical bundle cleanup deletes only the exact non-linked bundle directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-bundle-cleanup-'));
  try {
    const tauriRoot = path.join(root, 'apps', 'windows-client', 'src-tauri');
    const bundleRoot = path.join(tauriRoot, 'target', 'release', 'bundle');
    fs.mkdirSync(bundleRoot, { recursive: true });
    fs.writeFileSync(path.join(bundleRoot, 'stale.nsis.zip'), 'stale', 'utf8');

    cleanCanonicalBundleRoot(bundleRoot, tauriRoot);

    assert.equal(fs.existsSync(bundleRoot), false);
    assert.throws(
      () => cleanCanonicalBundleRoot(path.join(root, 'outside'), tauriRoot),
      /canonical Tauri bundle/i,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('canonical bundle cleanup rejects a symlink or Windows junction before deletion', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-bundle-link-'));
  try {
    const tauriRoot = path.join(root, 'apps', 'windows-client', 'src-tauri');
    const externalTarget = path.join(root, 'external-target');
    const linkedTarget = path.join(tauriRoot, 'target');
    const externalBundle = path.join(externalTarget, 'release', 'bundle');
    fs.mkdirSync(externalBundle, { recursive: true });
    fs.mkdirSync(tauriRoot, { recursive: true });
    fs.writeFileSync(path.join(externalBundle, 'must-survive.txt'), 'sentinel', 'utf8');
    try {
      fs.symlinkSync(externalTarget, linkedTarget, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      t.skip(`symlink/junction unavailable: ${String(error)}`);
      return;
    }

    assert.throws(
      () => cleanCanonicalBundleRoot(path.join(linkedTarget, 'release', 'bundle'), tauriRoot),
      /symbolic link|junction|reparse/i,
    );
    assert.equal(fs.readFileSync(path.join(externalBundle, 'must-survive.txt'), 'utf8'), 'sentinel');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('canonical bundle cleanup rejects linked entries nested inside the bundle tree', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-bundle-nested-link-'));
  try {
    const tauriRoot = path.join(root, 'apps', 'windows-client', 'src-tauri');
    const bundleRoot = path.join(tauriRoot, 'target', 'release', 'bundle');
    const externalTarget = path.join(root, 'external-target');
    const nestedLink = path.join(bundleRoot, 'nsis', 'linked-cache');
    fs.mkdirSync(path.dirname(nestedLink), { recursive: true });
    fs.mkdirSync(externalTarget, { recursive: true });
    fs.writeFileSync(path.join(externalTarget, 'must-survive.txt'), 'sentinel', 'utf8');
    try {
      fs.symlinkSync(externalTarget, nestedLink, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      t.skip(`symlink/junction unavailable: ${String(error)}`);
      return;
    }

    assert.throws(
      () => cleanCanonicalBundleRoot(bundleRoot, tauriRoot),
      /symbolic link|junction|reparse/i,
    );
    assert.equal(fs.readFileSync(path.join(externalTarget, 'must-survive.txt'), 'utf8'), 'sentinel');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('release manifest records artifact sha256 and source provenance', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-release-integrity-'));
  try {
    const sourcePath = path.join(root, 'installers', 'Agent Cowork_0.3.1_x64-setup.exe');
    const archivedPath = path.join(root, 'releases', 'v0.3.1', path.basename(sourcePath));
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(sourcePath, 'deterministic installer fixture', 'utf8');
    fs.mkdirSync(path.dirname(archivedPath), { recursive: true });
    fs.copyFileSync(sourcePath, archivedPath);

    const installer = createArtifactEvidence({
      sourcePath,
      archivedPath,
      repoRoot: root,
    });
    const runtimePath = path.join(root, 'target', 'release', 'agent-cowork-desktop.exe');
    fs.mkdirSync(path.dirname(runtimePath), { recursive: true });
    fs.writeFileSync(runtimePath, 'signed runtime fixture', 'utf8');
    const runtimeExecutable = createArtifactEvidence({
      sourcePath: runtimePath,
      archivedPath: runtimePath,
      repoRoot: root,
    });
    const manifest = createReleaseManifest({
      version: '0.3.1',
      tag: 'v0.3.1',
      sourceCommit: '0123456789abcdef0123456789abcdef01234567',
      built: '2026-07-10T00:00:00.000Z',
      packageName: 'agent-cowork-host-mvp',
      bundle: {
        path: 'releases/v0.3.1/agent-cowork-v0.3.1.bundle',
        sha256: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
        bytes: 42,
      },
      installers: [installer],
      runtimeExecutables: [runtimeExecutable],
      signaturesVerified: true,
      updaterArtifacts: [],
      updateManifest: null,
      sourceGate: 'passed: npm run ci',
    });

    assert.match(installer.sha256, /^[0-9a-f]{64}$/);
    assert.equal(installer.path, 'releases/v0.3.1/Agent Cowork_0.3.1_x64-setup.exe');
    assert.equal(installer.source, 'installers/Agent Cowork_0.3.1_x64-setup.exe');
    assert.equal(installer.bytes, fs.statSync(archivedPath).size);
    assert.equal(manifest.commit, '0123456789abcdef0123456789abcdef01234567');
    assert.equal(manifest.installers[0]?.sha256, installer.sha256);
    assert.equal(manifest.runtimeExecutables[0]?.sha256, runtimeExecutable.sha256);
    assert.equal(manifest.provenance.signaturesVerified, true);
    assert.equal(manifest.provenance.sourceCommit, manifest.commit);
    assert.equal(manifest.provenance.generatedBy, 'scripts/release.ts');
    assert.equal(manifest.provenance.sourceGate, 'passed: npm run ci');
    assert.ok(manifest.acceptance.requiredExternal.includes('installed-tauri-smoke'));
    assert.ok(manifest.acceptance.requiredExternal.includes('trusted-code-signing-verification'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('release evidence fails closed when the archived copy differs from its source', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-release-copy-integrity-'));
  try {
    const sourcePath = path.join(root, 'bundle', 'Agent Cowork_0.3.1_x64-setup.exe');
    const archivedPath = path.join(root, 'releases', 'v0.3.1', path.basename(sourcePath));
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.mkdirSync(path.dirname(archivedPath), { recursive: true });
    fs.writeFileSync(sourcePath, 'trusted source bytes', 'utf8');
    fs.writeFileSync(archivedPath, 'tampered archived bytes', 'utf8');

    assert.throws(
      () => createArtifactEvidence({ sourcePath, archivedPath, repoRoot: root }),
      /archived artifact differs from source/i,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
