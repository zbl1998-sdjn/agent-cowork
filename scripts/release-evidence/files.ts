// Release evidence filesystem boundary (scripts · local evidence)
// ---------------------------------------------------------------------------
// Owns repo-root resolution, path jailing, immutable report creation, version
// reads, and digest calculation. It performs no external network operations.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveJailedOutputPath } from '../release-path-boundary.js';
import {
  isRecord,
  requiredString,
  semverPattern,
  type JsonRecord,
} from './validators.js';

export const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

export function resolveReleaseEvidencePath(
  base: string,
  candidate: string,
  label: string,
  mustExist = true,
): string {
  const resolved = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(repoRoot, candidate);
  return resolveJailedOutputPath(base, resolved, label, mustExist);
}

export function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
}

function readCargoVersion(filePath: string): string {
  const match = /^\s*version\s*=\s*"([^"]+)"\s*$/m.exec(
    fs.readFileSync(filePath, 'utf8').split(/^\s*\[package\]\s*$/m)[1]?.split(/^\s*\[/m)[0] || '',
  );
  if (!match?.[1]) throw new Error('Cargo.toml [package] version is missing');
  return match[1];
}

function readJsonVersion(filePath: string): string {
  const value = readJson(filePath);
  if (!isRecord(value)) throw new Error(`JSON object expected: ${filePath}`);
  return requiredString(value.version, `${filePath} version`);
}

export function validateProjectVersion(expectedVersion: string): JsonRecord {
  if (!semverPattern.test(expectedVersion)) {
    throw new Error(`Invalid expected SemVer: ${expectedVersion}`);
  }
  const versions = {
    root: readJsonVersion(path.join(repoRoot, 'package.json')),
    ui: readJsonVersion(path.join(repoRoot, 'apps', 'windows-client', 'ui', 'package.json')),
    cargo: readCargoVersion(
      path.join(repoRoot, 'apps', 'windows-client', 'src-tauri', 'Cargo.toml'),
    ),
    tauri: readJsonVersion(
      path.join(repoRoot, 'apps', 'windows-client', 'src-tauri', 'tauri.conf.json'),
    ),
  };
  for (const [source, version] of Object.entries(versions)) {
    if (version !== expectedVersion) {
      throw new Error(`${source} version ${version} does not match ${expectedVersion}`);
    }
  }
  const changelog = fs.readFileSync(path.join(repoRoot, 'CHANGELOG.md'), 'utf8');
  const versionHeading = new RegExp(
    `^##\\s+(?:\\[)?${expectedVersion.replaceAll('.', '\\.')}(?:\\])?(?:\\s|$)`,
    'm',
  );
  if (!versionHeading.test(changelog)) {
    throw new Error(`CHANGELOG.md is missing ${expectedVersion}`);
  }
  return versions;
}

export function fileEvidence(filePath: string): JsonRecord {
  const bytes = fs.readFileSync(filePath);
  return {
    path: path.relative(repoRoot, filePath).replaceAll('\\', '/'),
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

export function writeReport(reportPath: string | null, report: JsonRecord): void {
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (!reportPath) {
    process.stdout.write(json);
    return;
  }
  const resolved = resolveReleaseEvidencePath(repoRoot, reportPath, 'Evidence report path', false);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, json, { encoding: 'utf8', flag: 'wx' });
  console.log(`[release-evidence] wrote ${path.relative(repoRoot, resolved)}`);
}
