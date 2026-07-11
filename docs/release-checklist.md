# Release Checklist

Use this checklist for every milestone release.

## Before Release

- [ ] `docs/面试演示与上线预备验收标准.md` has been applied: P0/P1 are zero, no one-vote veto item remains, and any P2/P3 deferral is recorded with evidence.
- [ ] Version is valid SemVer and has a matching `CHANGELOG.md` entry.
- [ ] Full local-source gate passes: `python -X utf8 scripts/quality_gate.py --level full`. Keep its command output with the release evidence. `npm run ci` is only one delegated layer.
- [ ] Eval evidence names the exact `KCW_EVAL_REPLAY_RECORDS` file. Replay success is deterministic regression evidence, not a live-model or production-network result.
- [ ] Q6: `npm run smoke:e2e` writes a JSON report under `reports/e2e-smoke/`.
- [ ] Q7: `npm run bench` writes a JSON baseline under `reports/bench/`; use `BENCH_FAIL_ON_REGRESSION=1 npm run bench` when enforcing thresholds.
- [ ] Q8/R5: the target-version installer is installed and its installed-client smoke is recorded as JSON under `reports/windows-client-smoke/`. A `-DryRun` report is planning evidence only. `smoke:windows-client` is the legacy C/Win32 source-build harness and does not accept the Tauri release.
- [ ] Known environment-only blockers are documented separately from code failures.
- [ ] No secrets, local credentials, or generated private data are included.
- [ ] Production signing credential is available before any executable release:
  - Preferred: import a trusted CA code-signing cert with private key, then set `KCW_CODESIGN_THUMBPRINT`.
  - Alternative: set `KCW_CODESIGN_PFX` and provide the password through `KCW_CODESIGN_PFX_PASSWORD` or a CI secret.
  - Do not use `scripts/sign-windows.ps1 -SelfSigned` for production distribution.
- [ ] `Get-AuthenticodeSignature` reports a trusted production signer for every executable installer and installed executable; a development self-signed signature is not acceptance.
- [ ] Production updater artifacts, signatures, endpoint and an actual update round trip are recorded. The placeholder `updates.agent-cowork.local` endpoint is not acceptance.
- [ ] The exact installer passes both `gh attestation verify <installer> --repo <owner/repository> --predicate-type https://slsa.dev/provenance/v1` and `gh attestation verify <installer> --repo <owner/repository> --predicate-type https://cyclonedx.org/bom` against the release repository. An artifact attestation is provenance evidence, not production acceptance.
- [ ] A non-empty CycloneDX SBOM is bound to the exact installer digest; merely generating an unverified or empty JSON file is not evidence.
- [ ] `--skip-ci` and `--skip-sign` are not used for a production release.

## Supply-chain Evidence Scaffold

`.github/workflows/release-evidence.yml` is a manual, non-publishing evidence workflow. It requires an explicit acknowledgement before it creates external GitHub attestation records, builds one ephemeral **unsigned** NSIS subject from the checked-out commit, generates a CycloneDX SBOM, creates provenance and SBOM attestations, and separately verifies the SLSA provenance and CycloneDX predicate types. It does not upload a workflow artifact, create a GitHub Release, read a signing secret, or contact an updater endpoint.

Run the local inspector against already-generated files without external verification:

```powershell
node scripts/run-host-node.mjs scripts/release-evidence.ts `
  --version <semver> `
  --release-dir <repo-relative-evidence-directory> `
  --installer <repo-relative-installer-path> `
  --sbom <repo-relative-cyclonedx-json-path> `
  --report reports/release-evidence/<semver>-plan.json
```

The expected result is `PENDING_EXTERNAL`. `--verify` is intentionally fail-closed and additionally requires a trusted public signer thumbprint, `owner/repository` for both GitHub predicate checks, a non-placeholder updater configuration, and a SemVer-matched updater round-trip report whose origin and fixed path prefix match the configured endpoint. The inspector validates a supplied JSON report but never contacts the updater endpoint. Even a fully verified report is named `EVIDENCE_VERIFIED_PENDING_HUMAN_SIGNOFF`; it is never an automatic release approval.

Current-source basis verified on 2026-07-11: [GitHub artifact attestations](https://docs.github.com/en/actions/concepts/security/artifact-attestations), [GitHub `actions/attest`](https://github.com/actions/attest), [GitHub CLI attestation verification](https://cli.github.com/manual/gh_attestation_verify), [the pinned `actions/attest` CycloneDX predicate implementation](https://github.com/actions/attest/blob/a1948c3f048ba23858d222213b7c278aabede763/src/sbom.ts), [Syft v1.42.3 Python cataloger filename rules](https://github.com/anchore/syft/blob/v1.42.3/syft/pkg/cataloger/python/cataloger.go), [Tauri Windows code signing](https://v2.tauri.app/distribute/sign/windows/), and [Tauri updater signing/configuration](https://v2.tauri.app/plugin/updater/). Tauri requires updater signatures and does not allow disabling that verification; GitHub also states that attestations must be verified and are not themselves a security guarantee.

## Dry Run

Run:

```powershell
python -X utf8 scripts/quality_gate.py --level full
npm run smoke:e2e
npm run bench
npm run smoke:installed-tauri -- -DryRun
npm run release -- --version <semver>
```

Confirm the plan includes:

- `releases/v<semver>/VERSION.txt`
- `releases/v<semver>/agent-cowork-v<semver>.bundle`
- Tauri build-time signing through `scripts/sign-windows.ps1 -Thumbprint ...` or `-Pfx ...`, covering the host sidecar, desktop executable, NSIS uninstaller and installer
- installer archive copies from `apps/windows-client/src-tauri/target/release/bundle/nsis/`
- annotated git tag `v<semver>`
- an installer whose filename contains the exact target version; a stale installer must make the release plan fail

Dry-run must not create tags, bundles, archives, or VERSION files.

## Execute

Only execute from a clean worktree:

```powershell
python -X utf8 scripts/quality_gate.py --level full
$env:E2E_SMOKE_REAL = "1"; npm run smoke:e2e; Remove-Item Env:E2E_SMOKE_REAL
$env:BENCH_FAIL_ON_REGRESSION = "1"; npm run bench; Remove-Item Env:BENCH_FAIL_ON_REGRESSION
$env:KCW_CODESIGN_THUMBPRINT = "<trusted-code-signing-cert-thumbprint>"
npm run smoke:installed-tauri -- -InstallerPath <path-to-installer> -InstalledExePath <path-to-installed-agent-cowork-desktop.exe>
npm run release -- --version <semver> --execute
Remove-Item Env:KCW_CODESIGN_THUMBPRINT
```

Expected artifacts:

- `releases/v<semver>/VERSION.txt`
- `releases/v<semver>/manifest.json`
- `releases/v<semver>/agent-cowork-v<semver>.bundle`
- archived installers, when available
- annotated tag `v<semver>`

The generated manifest intentionally records `localSourceGateOnly: true`. Release execution verifies the trusted Authenticode chain it created, but installed-client and production-updater checks remain external acceptance. Do not publish merely because `npm run release -- --execute` created files and a tag.

## Rollback

- Do not delete the bundle or VERSION file after publication.
- If a release was executed accidentally before publication, delete the local tag only after confirming no one else consumed it.
- Keep the failed release notes in `CHANGELOG.md` with the reason it was superseded.
