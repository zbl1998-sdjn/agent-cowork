import { register } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const loaderUrl = pathToFileURL(path.join(repoRoot, 'scripts', 'host-ts-loader.mjs'));

register(loaderUrl, pathToFileURL(`${repoRoot}${path.sep}`));
