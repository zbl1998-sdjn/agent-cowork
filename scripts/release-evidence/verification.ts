// Release evidence external verification adapters (scripts · bounded reads)
// ---------------------------------------------------------------------------
// Verifies supplied public Authenticode and GitHub attestation evidence with
// bounded child processes. It never signs or uploads an artifact.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { repoRoot } from './files.js';

const githubAttestationPredicateTypes = [
  'https://slsa.dev/provenance/v1',
  'https://cyclonedx.org/bom',
] as const;

function runBounded(command: string, args: string[], timeoutMs: number): void {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    timeout: timeoutMs,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`${command} verification failed (${String(result.status)}): ${detail}`);
  }
}

export function verifyAuthenticode(installerPath: string, thumbprint: string): void {
  const normalized = thumbprint.replace(/\s/g, '').toUpperCase();
  if (!/^[0-9A-F]{40}$/.test(normalized)) {
    throw new Error('Expected signer thumbprint must contain exactly 40 hexadecimal characters');
  }
  if (process.platform !== 'win32') throw new Error('Authenticode verification requires Windows');
  runBounded('pwsh', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    path.join(repoRoot, 'scripts', 'sign-windows.ps1'),
    '-VerifyOnly',
    '-ExpectedThumbprint',
    normalized,
    '-Files',
    installerPath,
    '-SignToolTimeoutSeconds',
    '120',
  ], 180_000);
}

export function buildGitHubAttestationVerificationRequests(
  installerPath: string,
  repository: string,
): Array<{ command: string; args: string[] }> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error('GitHub repository must use owner/repository form');
  }
  return githubAttestationPredicateTypes.map((predicateType) => ({
    command: 'gh',
    args: [
      'attestation',
      'verify',
      installerPath,
      '--repo',
      repository,
      '--predicate-type',
      predicateType,
    ],
  }));
}

export function verifyGitHubAttestations(installerPath: string, repository: string): void {
  for (const request of buildGitHubAttestationVerificationRequests(installerPath, repository)) {
    runBounded(request.command, request.args, 120_000);
  }
}
