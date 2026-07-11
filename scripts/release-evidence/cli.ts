// Release evidence CLI orchestration (scripts · outer layer)
// ---------------------------------------------------------------------------
// Composes pure validators, jailed local evidence access, and explicitly
// requested bounded public verification. No signing, uploading, or updater
// endpoint connection is performed.

import fs from 'node:fs';
import path from 'node:path';
import {
  fileEvidence,
  readJson,
  repoRoot,
  resolveReleaseEvidencePath,
  validateProjectVersion,
  writeReport,
} from './files.js';
import {
  githubAttestationSbomLimitBytes,
  installerFileNameMatchesVersion,
  inspectUpdaterConfiguration,
  validateCycloneDxSbom,
  validateUpdaterRoundTripReport,
  type JsonRecord,
  type UpdaterRoundTripReport,
} from './validators.js';
import {
  verifyAuthenticode,
  verifyGitHubAttestations,
} from './verification.js';

type CliOptions = {
  expectedVersion: string | null;
  releaseDirectory: string | null;
  installerPath: string | null;
  sbomPath: string | null;
  updaterRoundTripReportPath: string | null;
  expectedSignerThumbprint: string | null;
  githubRepository: string | null;
  reportPath: string | null;
  verify: boolean;
};

function requiredArgument(args: string[], index: number, option: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${option} requires a value`);
  return value;
}

function usage(): never {
  console.log([
    'Usage: node scripts/run-host-node.mjs scripts/release-evidence.ts',
    '  --version <semver> --release-dir <directory>',
    '  [--installer <path>] [--sbom <path>] [--report <path>]',
    '  [--verify --expected-signer-thumbprint <sha1> --github-repository <owner/repo>',
    '   --updater-round-trip-report <path>]',
    '',
    'Default mode writes PENDING_EXTERNAL planning evidence only.',
    '--verify reads public evidence; it never signs, uploads, or contacts an updater endpoint.',
  ].join('\n'));
  process.exit(0);
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    expectedVersion: null,
    releaseDirectory: null,
    installerPath: null,
    sbomPath: null,
    updaterRoundTripReportPath: null,
    expectedSignerThumbprint: null,
    githubRepository: null,
    reportPath: null,
    verify: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') usage();
    if (arg === '--verify') {
      options.verify = true;
      continue;
    }
    const value = requiredArgument(args, index, arg || '<missing>');
    index += 1;
    if (arg === '--version') options.expectedVersion = value;
    else if (arg === '--release-dir') options.releaseDirectory = value;
    else if (arg === '--installer') options.installerPath = value;
    else if (arg === '--sbom') options.sbomPath = value;
    else if (arg === '--updater-round-trip-report') options.updaterRoundTripReportPath = value;
    else if (arg === '--expected-signer-thumbprint') options.expectedSignerThumbprint = value;
    else if (arg === '--github-repository') options.githubRepository = value;
    else if (arg === '--report') options.reportPath = value;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function runReleaseEvidenceCli(args: string[]): void {
  const options = parseArgs(args);
  const expectedVersion = options.expectedVersion;
  const releaseDirectoryOption = options.releaseDirectory;
  if (!expectedVersion) throw new Error('--version is required');
  if (!releaseDirectoryOption) throw new Error('--release-dir is required');

  const releaseDirectory = resolveReleaseEvidencePath(
    repoRoot,
    releaseDirectoryOption,
    'Release evidence directory',
  );
  const versions = validateProjectVersion(expectedVersion);
  const updaterConfig = readJson(
    path.join(repoRoot, 'apps', 'windows-client', 'src-tauri', 'tauri.conf.json'),
  );
  const updater = inspectUpdaterConfiguration(updaterConfig);
  const blockers = [...updater.blockers];

  let installerEvidence: JsonRecord | null = null;
  let sbomEvidence: JsonRecord | null = null;
  let updaterRoundTrip: UpdaterRoundTripReport | null = null;
  let authenticodeVerified = false;
  let githubAttestationVerified = false;

  if (options.installerPath) {
    try {
      const installer = resolveReleaseEvidencePath(
        releaseDirectory,
        options.installerPath,
        'Installer',
      );
      if (!installerFileNameMatchesVersion(installer, expectedVersion)) {
        throw new Error(`Installer filename must contain exact version ${expectedVersion}`);
      }
      installerEvidence = fileEvidence(installer);
      if (options.verify && options.expectedSignerThumbprint) {
        verifyAuthenticode(installer, options.expectedSignerThumbprint);
        authenticodeVerified = true;
      } else {
        blockers.push('Trusted Authenticode verification is PENDING_EXTERNAL.');
      }
      if (options.verify && options.githubRepository) {
        verifyGitHubAttestations(installer, options.githubRepository);
        githubAttestationVerified = true;
      } else {
        blockers.push('GitHub artifact attestation verification is PENDING_EXTERNAL.');
      }
    } catch (error) {
      blockers.push(`Installer evidence failed: ${errorMessage(error)}`);
    }
  } else {
    blockers.push('Installer evidence is missing.');
  }

  if (options.sbomPath) {
    try {
      const sbom = resolveReleaseEvidencePath(releaseDirectory, options.sbomPath, 'SBOM');
      if (fs.statSync(sbom).size > githubAttestationSbomLimitBytes) {
        throw new Error('CycloneDX SBOM exceeds the GitHub attestation 16 MB input limit');
      }
      const summary = validateCycloneDxSbom(readJson(sbom));
      sbomEvidence = { ...fileEvidence(sbom), ...summary };
    } catch (error) {
      blockers.push(`SBOM evidence failed: ${errorMessage(error)}`);
    }
  } else {
    blockers.push('CycloneDX SBOM evidence is missing.');
  }

  if (options.updaterRoundTripReportPath) {
    try {
      const updaterReport = resolveReleaseEvidencePath(
        releaseDirectory,
        options.updaterRoundTripReportPath,
        'Updater round-trip report',
      );
      updaterRoundTrip = validateUpdaterRoundTripReport(
        readJson(updaterReport),
        expectedVersion,
        updater.endpoints,
      );
    } catch (error) {
      blockers.push(`Updater round-trip evidence failed: ${errorMessage(error)}`);
    }
  } else {
    blockers.push('Production updater round-trip evidence is PENDING_EXTERNAL.');
  }

  const status = options.verify && blockers.length === 0
    ? 'EVIDENCE_VERIFIED_PENDING_HUMAN_SIGNOFF'
    : 'PENDING_EXTERNAL';
  const report: JsonRecord = {
    schemaVersion: 1,
    status,
    generatedAt: new Date().toISOString(),
    expectedVersion,
    projectVersions: versions,
    localEvidence: {
      installer: installerEvidence,
      sbom: sbomEvidence,
    },
    externalEvidence: {
      authenticodeVerified,
      githubAttestationVerified,
      updaterConfigured: updater.configured,
      updaterEndpoints: updater.endpoints,
      updaterRoundTrip,
    },
    blockers,
    acceptanceBoundary: 'Evidence verification is not production approval; human release signoff remains required.',
  };
  writeReport(options.reportPath, report);
  if (options.verify && blockers.length > 0) {
    throw new Error(`Release evidence remains PENDING_EXTERNAL (${blockers.length} blocker(s))`);
  }
}
