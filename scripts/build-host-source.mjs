#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {
  assertHostTypeCoverage,
  hostBuildConfigPath,
  repoRoot,
  runTypeScriptProject,
} from './host-ts-support.mjs';

const outDir = path.join(repoRoot, 'build', 'host-src');

function assertBuildOutputPath(dir) {
  const relative = path.relative(path.join(repoRoot, 'build'), dir);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`[build-host-source] refusing to clean outside build/: ${dir}`);
  }
}

assertHostTypeCoverage();
assertBuildOutputPath(outDir);
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

process.exit(runTypeScriptProject(hostBuildConfigPath));
