#!/usr/bin/env node

import { register } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const currentUrl = new URL(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(currentUrl)), '..');
const loaderUrl = pathToFileURL(path.join(repoRoot, 'scripts', 'host-ts-loader.mjs'));

register(loaderUrl, pathToFileURL(`${repoRoot}${path.sep}`));

if (!currentUrl.searchParams.has('register-only')) {
  await import('./run-host-node.ts');
}
