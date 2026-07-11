// Release evidence inspector (scripts · thin entrypoint)
// ---------------------------------------------------------------------------
// Keeps the stable CLI and public validation exports while delegating pure
// validation, filesystem evidence, and bounded external verification to
// focused modules.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runReleaseEvidenceCli } from './release-evidence/cli.js';

export {
  installerFileNameMatchesVersion,
  inspectUpdaterConfiguration,
  validateCycloneDxSbom,
  validateUpdaterRoundTripReport,
} from './release-evidence/validators.js';
export type {
  CycloneDxSummary,
  UpdaterConfigurationInspection,
  UpdaterRoundTripReport,
} from './release-evidence/validators.js';
export { resolveReleaseEvidencePath } from './release-evidence/files.js';
export { buildGitHubAttestationVerificationRequests } from './release-evidence/verification.js';

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    runReleaseEvidenceCli(process.argv.slice(2));
  } catch (error) {
    console.error(`[release-evidence] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
