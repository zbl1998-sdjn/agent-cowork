import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const hostNode = (scriptPath: string): string => `node scripts/run-host-node.mjs ${scriptPath}`;
type PackageJson = { scripts: Record<string, string> };

test('Q6/Q7/R5 delivery scripts are registered and parseable', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as PackageJson;
  assert.equal(packageJson.scripts['smoke:e2e'], hostNode('scripts/e2e-smoke.ts'));
  assert.equal(packageJson.scripts['smoke:ui'], hostNode('scripts/smoke-ui-contract.ts'));
  assert.equal(packageJson.scripts['smoke:windows-paths'], hostNode('scripts/smoke-windows-paths.ts'));
  assert.equal(packageJson.scripts['demo:mvp'], hostNode('scripts/demo-mvp.ts'));
  assert.equal(packageJson.scripts['verify:mvp'], hostNode('scripts/verify-mvp.ts'));
  assert.equal(packageJson.scripts.bench, hostNode('scripts/bench.ts'));
  assert.equal(packageJson.scripts['smoke:kimi-api'], hostNode('scripts/smoke-kimi-api.ts'));
  assert.equal(packageJson.scripts['check:secrets'], hostNode('scripts/check-secrets.ts'));
  const windowsClientSmokeScript = packageJson.scripts['smoke:windows-client'];
  assert.ok(windowsClientSmokeScript);
  assert.match(windowsClientSmokeScript, /smoke-windows-client\.ps1/);

  const deliveryScripts = [
    'scripts/e2e-smoke.ts',
    'scripts/smoke-ui-contract.ts',
    'scripts/smoke-windows-paths.ts',
    'scripts/demo-mvp.ts',
    'scripts/verify-mvp.ts',
    'scripts/bench.ts',
    'scripts/check-secrets.ts',
    'scripts/smoke-kimi-api.ts',
  ] as const;
  for (const script of deliveryScripts) {
    assert.ok(fs.existsSync(path.join(repoRoot, script)), `${script} is missing`);
  }

  const kimiSmoke = fs.readFileSync(path.join(repoRoot, 'scripts/smoke-kimi-api.ts'), 'utf8');
  assert.match(kimiSmoke, /\/api\/auth\/guest/);
  assert.match(kimiSmoke, /Bearer \$\{guest\.token\}/);

  const windowsSmoke = fs.readFileSync(path.join(repoRoot, 'scripts/smoke-windows-client.ps1'), 'utf8');
  assert.match(windowsSmoke, /\[string\]\$ReportPath/);
  assert.match(windowsSmoke, /reports\\windows-client-smoke/);

  const installedTauriSmoke = fs.readFileSync(path.join(repoRoot, 'scripts/smoke-installed-tauri.ps1'), 'utf8');
  const installedArtifactEvidence = fs.readFileSync(path.join(repoRoot, 'scripts/installed-artifact-evidence.ps1'), 'utf8');
  const installedAcceptanceSurface = installedTauriSmoke + '\n' + installedArtifactEvidence;
  assert.match(installedAcceptanceSurface, /\[string\]\$ExpectedVersion/);
  assert.match(installedAcceptanceSurface, /InstallerPath is required for installed artifact verification/);
  assert.match(installedAcceptanceSurface, /Get-FileHash[^\n]+SHA256/);
  assert.match(installedAcceptanceSurface, /DisplayVersion[^\n]+ExpectedVersion/);
  assert.match(installedAcceptanceSurface, /ProductVersion[^\n]+ExpectedVersion/);
  assert.match(installedAcceptanceSurface, /ExpectedDesktopSha256/);
  assert.match(installedAcceptanceSurface, /ExpectedSidecarSha256/);
  assert.match(installedAcceptanceSurface, /sourceCommit/);

  const verifyMvp = fs.readFileSync(path.join(repoRoot, 'scripts/verify-mvp.ts'), 'utf8');
  assert.match(verifyMvp, /run-host-node\.mjs/);
  assert.match(verifyMvp, /demo-mvp\.ts/);
  assert.match(verifyMvp, /hostScriptArgs\('smoke-mvp-runtime\.ts'\)/);

  const mvpRuntimeSmoke = fs.readFileSync(path.join(repoRoot, 'scripts/smoke-mvp-runtime.ts'), 'utf8');
  assert.match(mvpRuntimeSmoke, /run-host-node\.mjs/);
  assert.match(mvpRuntimeSmoke, /isPidAlive\(runtime\.pid\)/);
});

test('legacy build2 wrapper delegates to canonical fail-fast gates', () => {
  const buildWrapper = fs.readFileSync(path.join(repoRoot, 'build2.ps1'), 'utf8');

  assert.match(buildWrapper, /Set-StrictMode -Version Latest/);
  assert.match(buildWrapper, /\$ErrorActionPreference\s*=\s*['"]Stop['"]/);
  assert.match(buildWrapper, /quality_gate\.py.*--level full/);
  assert.match(buildWrapper, /npm run build:host/);
  assert.match(buildWrapper, /cargo tauri build --ci --bundles nsis --no-sign -- --locked/);
  assert.equal(
    (buildWrapper.match(/Assert-NativeSuccess -Step .+ -ExitCode \$LASTEXITCODE/g) || []).length,
    3,
  );
  assert.doesNotMatch(buildWrapper, /test\/\*\.test\.js/);
  assert.doesNotMatch(buildWrapper, /BUILD OK/);
  assert.match(buildWrapper, /installed-tauri smoke.*trusted signing/i);
});

test('full quality gate reports a local source boundary instead of production acceptance', () => {
  const qualityGate = fs.readFileSync(path.join(repoRoot, 'scripts', 'quality_gate.py'), 'utf8');

  assert.match(qualityGate, /full local source gate passed/);
  assert.match(qualityGate, /external release acceptance remains required/);
  assert.match(qualityGate, /build:host/);
  assert.match(qualityGate, /cargo:test/);
  assert.match(qualityGate, /cargo.*tauri.*build.*--ci.*--bundles.*nsis.*--no-sign.*--locked/s);
  assert.doesNotMatch(qualityGate, /smoke:installed-tauri/);
});

test('release execution has no gate/signing bypass and builds canonical current artifacts', () => {
  const releaseScript = fs.readFileSync(path.join(repoRoot, 'scripts', 'release.ts'), 'utf8');
  const signingScript = fs.readFileSync(path.join(repoRoot, 'scripts', 'sign-windows.ps1'), 'utf8');

  assert.doesNotMatch(releaseScript, /--skip-ci|--skip-sign/);
  assert.match(releaseScript, /quality_gate\.py/);
  assert.match(releaseScript, /--level['"],\s*['"]full/);
  assert.match(releaseScript, /run\('npm', \['run', 'build:host'\]/);
  assert.match(releaseScript, /cargo[\s\S]*tauri[\s\S]*build[\s\S]*--locked/);
  assert.match(releaseScript, /cargo[\s\S]*build[\s\S]*--release[\s\S]*--features[\s\S]*custom-protocol/);
  assert.match(releaseScript, /runtimePeFiles/);
  assert.match(releaseScript, /signRuntimeExecutables/);
  assert.match(releaseScript, /verifyWindowsSignatures/);
  assert.match(releaseScript, /KCW_CODESIGN_PFX_PASSWORD/);
  assert.match(releaseScript, /PFX password is required for non-interactive release signing/);
  assert.match(releaseScript, /timeout:\s*options\.timeoutMs\s*\?\?\s*1_800_000/);
  assert.match(releaseScript, /target[\s\S]*release[\s\S]*bundle/);
  assert.doesNotMatch(releaseScript, /path\.join\(repoRoot, 'installers'\)/);
  assert.match(releaseScript, /assertReleaseVersions/);
  assert.match(releaseScript, /assertChangelogVersion/);
  assert.match(releaseScript, /cleanCanonicalBundleRoot\(bundleRootPath\(\), tauriRoot\)/);
  assert.match(releaseScript, /findUpdaterArtifacts\(targetVersion: string\)/);
  assert.match(releaseScript, /selectUpdaterArtifacts\(discovered, targetVersion\)/);
  assert.ok(
    releaseScript.indexOf('cleanCanonicalBundleRoot(bundleRootPath(), tauriRoot);')
      < releaseScript.indexOf('runCanonicalTauriPackage(signingConfig, options.execute);'),
    'canonical bundle cleanup must run before the Tauri package build',
  );
  assert.match(releaseScript, /verifyWindowsSignatures\([^)]*signingConfig/);
  assert.match(signingScript, /VerifyOnly/);
  assert.match(signingScript, /ExpectedThumbprint/);
  assert.match(signingScript, /ExpectedPfx/);
  assert.match(signingScript, /Resolve-PfxSignerThumbprint/);
  assert.match(signingScript, /Get-AuthenticodeSignature/);
  assert.match(signingScript, /Assert-ExpectedSigner/);
  assert.match(signingScript, /\$trustedSignature -and \$existingSigner -eq \$expectedSignerThumbprint/);
  assert.doesNotMatch(signingScript, /Already trusted-signed; skipping/);
  assert.match(signingScript, /throw "signing target missing:/);
  assert.match(signingScript, /@\('verify', '\/pa', '\/v', \$file\)/);
  assert.match(signingScript, /WaitForExit\(\$SignToolTimeoutSeconds \* 1000\)/);
  assert.match(signingScript, /Kill\(\$true\)/);
});

test('GitHub CI is lockfile-driven, SHA-pinned, coverage-enforced, and audits every runtime', () => {
  const workflow = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');

  assert.doesNotMatch(workflow, /uses:\s*[^@\s]+@v\d+/);
  assert.doesNotMatch(workflow, /runs-on:\s*(?:ubuntu|windows)-latest/);
  assert.match(workflow, /runs-on:\s*ubuntu-24\.04/);
  assert.match(workflow, /runs-on:\s*windows-2025/);
  for (const use of workflow.matchAll(/uses:\s*([^@\s]+)@([^\s#]+)/g)) {
    assert.match(String(use[2]), /^[a-f0-9]{40}$/, String(use[1]) + ' must be pinned to a full commit');
  }
  assert.match(workflow, /npm ci\b/);
  assert.match(workflow, /npm ci --prefix apps\/windows-client\/ui/);
  assert.doesNotMatch(workflow, /\bnpm install(?:\s|$)/m);
  assert.match(workflow, /npm run test:host:coverage:90/);
  assert.doesNotMatch(workflow, /ls test\/\*\.test\.ts/);
  assert.doesNotMatch(workflow, /KCW_TRUST_IDENTITY_HEADERS/);
  assert.match(workflow, /npm run build:host/);
  const desktopJob = workflow.slice(
    workflow.indexOf('  desktop-source-build:'),
    workflow.indexOf('  dependency-audit:'),
  );
  assert.match(desktopJob, /npm ci --prefix apps\/windows-client\/ui/);
  assert.match(desktopJob, /npm run build:ui/);
  assert.match(desktopJob, /rustup toolchain install 1\.96\.0 --profile minimal/);
  assert.match(desktopJob, /rustup default 1\.96\.0/);
  assert.match(workflow, /cargo check --manifest-path apps\/windows-client\/src-tauri\/Cargo\.toml --locked/);
  assert.match(desktopJob, /cargo test --manifest-path apps\/windows-client\/src-tauri\/Cargo\.toml --locked/);
  assert.match(desktopJob, /cargo install tauri-cli --locked --version 2\.11\.2/);
  assert.match(desktopJob, /cargo tauri build --ci --bundles nsis --no-sign -- --locked/);
  const dependencyAuditJob = workflow.slice(workflow.indexOf('  dependency-audit:'));
  assert.match(dependencyAuditJob, /rustup toolchain install 1\.96\.0 --profile minimal/);
  assert.match(dependencyAuditJob, /rustup default 1\.96\.0/);
  assert.match(workflow, /cargo install cargo-audit --locked --version 0\.22\.2/);
  assert.match(workflow, /govulncheck@v1\.6\.0/);
});
