import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const hostCheckConfigPath = path.join(repoRoot, 'tsconfig.host-checkjs.json');
export const hostBuildConfigPath = path.join(repoRoot, 'tsconfig.host-build.json');

const HOST_SOURCE_EXTENSIONS = new Set(['.js', '.ts']);

type TypeCoverageConfig = {
  files?: string[];
};

export type HostTypeCoverageIssues = {
  sources: string[];
  configuredHostSources: string[];
  missing: string[];
  stale: string[];
};

function toPosix(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

function walkHostSources(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkHostSources(full, out);
    } else if (HOST_SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

export function findHostTypeCoverageIssues(
  rootDir = repoRoot,
  hostConfigPath = hostCheckConfigPath,
): HostTypeCoverageIssues {
  const config = JSON.parse(fs.readFileSync(hostConfigPath, 'utf8')) as TypeCoverageConfig;
  const configured = new Set((config.files || []).map(toPosix));
  const hostSourceRoot = path.join(rootDir, 'apps', 'host', 'src');
  const sources = fs.existsSync(hostSourceRoot)
    ? walkHostSources(hostSourceRoot).map((file) => toPosix(path.relative(rootDir, file))).sort()
    : [];
  const configuredHostSources = [...configured]
    .filter((file) => /^apps\/host\/src\/.*\.(js|ts)$/.test(file))
    .sort();

  return {
    sources,
    configuredHostSources,
    missing: sources.filter((file) => !configured.has(file)),
    stale: configuredHostSources.filter((file) => !fs.existsSync(path.join(rootDir, file))),
  };
}

export function assertHostTypeCoverage(rootDir = repoRoot, hostConfigPath = hostCheckConfigPath): void {
  const issues = findHostTypeCoverageIssues(rootDir, hostConfigPath);
  if (!issues.missing.length && !issues.stale.length) return;

  console.error('[check-host-types] tsconfig.host-checkjs.json does not cover every host source file.');
  for (const file of issues.missing) console.error(`- missing from tsconfig: ${file}`);
  for (const file of issues.stale) console.error(`- stale tsconfig entry: ${file}`);
  process.exit(1);
}

export function findTypescriptCompiler(rootDir = repoRoot): string | undefined {
  const candidates = [
    path.join(rootDir, 'node_modules', 'typescript', 'bin', 'tsc'),
    path.join(rootDir, 'apps', 'windows-client', 'ui', 'node_modules', 'typescript', 'bin', 'tsc'),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate));
}

export function runTypeScriptProject(configPath: string, rootDir = repoRoot): number {
  const tscPath = findTypescriptCompiler(rootDir);
  if (!tscPath) {
    console.error('[host-ts] TypeScript compiler not found. Run npm install in apps/windows-client/ui first.');
    return 1;
  }

  const result = spawnSync(process.execPath, [tscPath, '-p', configPath, '--pretty', 'false'], {
    cwd: rootDir,
    stdio: 'inherit',
  });

  return result.status ?? 1;
}
