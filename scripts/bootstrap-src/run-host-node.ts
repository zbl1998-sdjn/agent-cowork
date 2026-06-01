#!/usr/bin/env node

import { register } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const currentUrl = new URL(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(currentUrl)), '..');
const loaderUrl = pathToFileURL(path.join(repoRoot, 'scripts', 'host-ts-loader.mjs'));
const runnerScript = './run-host-node.ts';

register(loaderUrl, pathToFileURL(`${repoRoot}${path.sep}`));

// Normal mode runs the TS CLI wrapper. Child Node processes import this same
// file with ?register-only=1 so they only install the TS loader before running
// their own entrypoint.
if (!currentUrl.searchParams.has('register-only')) {
  await import(runnerScript);
}
