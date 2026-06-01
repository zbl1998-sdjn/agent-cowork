import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertHostTypeCoverage,
  findHostTypeCoverageIssues,
  hostCheckConfigPath,
  runTypeScriptProject,
} from './host-ts-support.mjs';

export { findHostTypeCoverageIssues };

function runMain(): never {
  assertHostTypeCoverage();
  process.exit(runTypeScriptProject(hostCheckConfigPath));
}

const invokedAsMain = Boolean(process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url));
if (invokedAsMain) runMain();
