import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildGitHubAttestationVerificationRequests,
  installerFileNameMatchesVersion,
  inspectUpdaterConfiguration,
  resolveReleaseEvidencePath,
  validateCycloneDxSbom,
  validateUpdaterRoundTripReport,
} from '../../../scripts/release-evidence.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

test('release evidence workflow is manual, immutable, non-publishing, and fail-closed', () => {
  const workflowPath = path.join(repoRoot, '.github', 'workflows', 'release-evidence.yml');
  const workflow = fs.readFileSync(workflowPath, 'utf8');

  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /^\s+(?:push|pull_request|release):/m);
  assert.match(workflow, /acknowledge_attestation_upload:[\s\S]*type:\s*boolean[\s\S]*default:\s*false/);
  assert.match(workflow, /Refusing to create external GitHub attestations without explicit acknowledgement/);

  for (const use of workflow.matchAll(/uses:\s*([^@\s]+)@([^\s#]+)/g)) {
    assert.match(String(use[2]), /^[a-f0-9]{40}$/, `${String(use[1])} must be pinned to a full commit`);
  }
  assert.match(workflow, /actions\/attest@a1948c3f048ba23858d222213b7c278aabede763/);
  assert.match(workflow, /anchore\/sbom-action@e22c389904149dbc22b58101806040fa8d37a610/);
  assert.match(workflow, /syft-version:\s*["']?v1\.42\.3/);
  assert.match(workflow, /path:\s*release-evidence\/sbom-input/);
  for (const shippedDependencyLock of [
    'package-lock.json',
    'apps/windows-client/ui/package-lock.json',
    'apps/windows-client/src-tauri/Cargo.lock',
    'apps/windows-client/resources/python-packages.lock',
    'apps/windows-client/resources/python-bootstrap.lock',
  ]) {
    assert.ok(workflow.includes(shippedDependencyLock), `SBOM input is missing ${shippedDependencyLock}`);
  }
  assert.match(workflow, /requirements-windows\.txt/);
  assert.match(workflow, /upload-artifact:\s*false/);
  assert.match(workflow, /upload-release-assets:\s*false/);
  assert.match(workflow, /dependency-snapshot:\s*false/);

  assert.match(workflow, /id-token:\s*write/);
  assert.match(workflow, /attestations:\s*write/);
  assert.match(workflow, /artifact-metadata:\s*write/);
  assert.doesNotMatch(workflow, /contents:\s*write/);
  assert.doesNotMatch(workflow, /packages:\s*write/);
  assert.doesNotMatch(workflow, /actions\/upload-artifact/);
  assert.doesNotMatch(workflow, /\$\{\{\s*secrets\./);

  assert.match(workflow, /quality_gate\.py --level full/);
  assert.match(workflow, /cargo tauri build --ci --bundles nsis --no-sign -- --locked/);
  assert.match(workflow, /subject-path:/);
  assert.match(workflow, /sbom-path:/);
  assert.match(workflow, /gh attestation verify[^\n]*--predicate-type https:\/\/slsa\.dev\/provenance\/v1/);
  assert.match(workflow, /gh attestation verify[^\n]*--predicate-type https:\/\/cyclonedx\.org\/bom/);
  assert.match(
    workflow,
    /name: Verify that GitHub can resolve the new attestation[\s\S]*?timeout-minutes:\s*5[\s\S]*?gh attestation verify/,
  );
  assert.match(workflow, /PENDING_EXTERNAL/);
});

test('release evidence workflow provisions the exact full-gate audit toolchain', () => {
  const workflow = fs.readFileSync(
    path.join(repoRoot, '.github', 'workflows', 'release-evidence.yml'),
    'utf8',
  );

  assert.match(workflow, /actions\/setup-go@924ae3a1cded613372ab5595356fb5720e22ba16/);
  assert.match(workflow, /go-version:\s*["']1\.26\.5["']/);

  const installStep = workflow.indexOf('      - name: Install the pinned full-gate audit tools');
  const verifyStep = workflow.indexOf('      - name: Verify the pinned full-gate toolchain on PATH');
  const gateStep = workflow.indexOf('      - name: Run the full local-source quality gate');
  assert.ok(installStep >= 0, 'release evidence must install the full-gate audit tools');
  assert.ok(verifyStep > installStep, 'tool verification must run after installation');
  assert.ok(gateStep > verifyStep, 'the full gate must run only after independent tool verification');

  const installBody = workflow.slice(installStep, verifyStep);
  assert.match(installBody, /cargo install cargo-audit --locked --version 0\.22\.2/);
  assert.match(installBody, /go install golang\.org\/x\/vuln\/cmd\/govulncheck@v1\.6\.0/);
  assert.match(installBody, /pip-audit-2\.10\.1/);
  assert.match(installBody, /pip-audit==2\.10\.1/);
  assert.match(installBody, /GITHUB_PATH/);

  const verifyBody = workflow.slice(verifyStep, gateStep);
  for (const expectedVersion of [
    '10.9.8',
    'go1.26.5',
    'cargo-audit 0.22.2',
    'v1.6.0',
    'pip-audit 2.10.1',
  ]) {
    assert.ok(verifyBody.includes(expectedVersion), `missing tool verification for ${expectedVersion}`);
  }
  assert.match(verifyBody, /npm --version/);
  assert.match(verifyBody, /go version/);
  assert.match(verifyBody, /cargo audit --version/);
  assert.match(verifyBody, /govulncheck -version/);
  assert.match(verifyBody, /pip-audit --version/);
});

test('local verifier checks both provenance and CycloneDX attestations', () => {
  const installer = 'C:\\evidence\\Agent-Cowork_0.3.0_x64-setup.exe';
  assert.deepEqual(buildGitHubAttestationVerificationRequests(installer, 'owner/repository'), [
    {
      command: 'gh',
      args: [
        'attestation',
        'verify',
        installer,
        '--repo',
        'owner/repository',
        '--predicate-type',
        'https://slsa.dev/provenance/v1',
      ],
    },
    {
      command: 'gh',
      args: [
        'attestation',
        'verify',
        installer,
        '--repo',
        'owner/repository',
        '--predicate-type',
        'https://cyclonedx.org/bom',
      ],
    },
  ]);
  assert.throws(
    () => buildGitHubAttestationVerificationRequests(installer, 'invalid'),
    /owner\/repository/i,
  );
});

test('CycloneDX validation rejects empty or ambiguous SBOM evidence', () => {
  const valid = {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    serialNumber: 'urn:uuid:12345678-1234-4234-8234-123456789abc',
    metadata: { timestamp: '2026-07-11T00:00:00Z' },
    components: [
      { type: 'library', name: 'example', version: '1.2.3', 'bom-ref': 'pkg:npm/example@1.2.3' },
    ],
  };

  assert.deepEqual(validateCycloneDxSbom(valid), { componentCount: 1, specVersion: '1.6' });
  assert.throws(() => validateCycloneDxSbom({ ...valid, components: [] }), /at least one component/i);
  assert.throws(
    () => validateCycloneDxSbom({
      ...valid,
      components: [valid.components[0], valid.components[0]],
    }),
    /duplicate bom-ref/i,
  );
});

test('release evidence paths stay jailed and installer versions match exact filename tokens', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-release-evidence-'));
  try {
    const evidenceRoot = path.join(root, 'evidence');
    const installer = path.join(evidenceRoot, 'Agent-Cowork_0.3.1_x64-setup.exe');
    const outside = path.join(root, 'outside.exe');
    fs.mkdirSync(evidenceRoot);
    fs.writeFileSync(installer, 'installer');
    fs.writeFileSync(outside, 'outside');

    assert.equal(resolveReleaseEvidencePath(evidenceRoot, installer, 'Installer'), installer);
    assert.throws(
      () => resolveReleaseEvidencePath(evidenceRoot, outside, 'Installer'),
      /must stay inside/i,
    );
    assert.equal(installerFileNameMatchesVersion(installer, '0.3.1'), true);
    assert.equal(installerFileNameMatchesVersion('Agent-Cowork_10.3.1_x64-setup.exe', '0.3.1'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('release evidence rejects a new output below a linked parent directory', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-release-output-link-'));
  try {
    const evidenceRoot = path.join(root, 'evidence');
    const outside = path.join(root, 'outside');
    const linkedReports = path.join(evidenceRoot, 'reports');
    fs.mkdirSync(evidenceRoot);
    fs.mkdirSync(outside);
    try {
      fs.symlinkSync(outside, linkedReports, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      t.skip(`symlink/junction unavailable: ${String(error)}`);
      return;
    }

    assert.throws(
      () => resolveReleaseEvidencePath(
        evidenceRoot,
        path.join(linkedReports, 'evidence.json'),
        'Evidence report path',
        false,
      ),
      /symbolic link|junction|reparse|resolves outside/i,
    );
    assert.equal(fs.existsSync(path.join(outside, 'evidence.json')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('updater evidence stays pending for placeholder config and validates a real round trip contract', () => {
  const placeholder = inspectUpdaterConfiguration({
    bundle: { createUpdaterArtifacts: false },
    plugins: {
      updater: {
        pubkey: 'public-key',
        endpoints: ['https://updates.agent-cowork.local/update/{{target}}'],
      },
    },
  });
  assert.equal(placeholder.configured, false);
  assert.ok(placeholder.blockers.some((blocker) => blocker.includes('createUpdaterArtifacts')));
  assert.ok(placeholder.blockers.some((blocker) => blocker.includes('placeholder')));

  const configuredEndpoints = [
    'https://updates.vendor.net/desktop/{{target}}/{{arch}}/{{current_version}}',
  ];
  const report = validateUpdaterRoundTripReport({
    schemaVersion: 1,
    status: 'passed',
    version: '0.3.1',
    endpoint: 'https://updates.vendor.net/desktop/windows/x86_64/0.3.1',
    checkedAt: '2026-07-11T00:00:00Z',
    fromVersion: '0.3.0',
    toVersion: '0.3.1',
    updaterSignatureVerified: true,
    installedClientLaunched: true,
  }, '0.3.1', configuredEndpoints);
  assert.equal(report.toVersion, '0.3.1');
  assert.throws(
    () => validateUpdaterRoundTripReport(
      { ...report, updaterSignatureVerified: false },
      '0.3.1',
      configuredEndpoints,
    ),
    /signature/i,
  );
  assert.throws(
    () => validateUpdaterRoundTripReport(
      { ...report, endpoint: 'https://updates.agent-cowork.local/x' },
      '0.3.1',
      configuredEndpoints,
    ),
    /placeholder/i,
  );
  assert.throws(
    () => validateUpdaterRoundTripReport(
      { ...report, endpoint: 'https://other.vendor.net/desktop/windows/x86_64/0.3.1' },
      '0.3.1',
      configuredEndpoints,
    ),
    /configured updater endpoint/i,
  );
  assert.throws(
    () => validateUpdaterRoundTripReport(
      { ...report, fromVersion: 'not-semver' },
      '0.3.1',
      configuredEndpoints,
    ),
    /SemVer/i,
  );
});

test('release checklist keeps source attestation separate from production acceptance', () => {
  const checklist = fs.readFileSync(path.join(repoRoot, 'docs', 'release-checklist.md'), 'utf8');
  assert.match(checklist, /release-evidence\.yml/);
  assert.match(checklist, /PENDING_EXTERNAL/);
  assert.match(checklist, /artifact attestation[^\n]*not[^\n]*production acceptance/i);
  assert.match(checklist, /gh attestation verify/);
  assert.match(checklist, /https:\/\/slsa\.dev\/provenance\/v1/);
  assert.match(checklist, /https:\/\/cyclonedx\.org\/bom/);
});
