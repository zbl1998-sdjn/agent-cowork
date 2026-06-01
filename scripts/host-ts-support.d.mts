export const repoRoot: string;
export const hostCheckConfigPath: string;
export const hostBuildConfigPath: string;

export type HostTypeCoverageIssues = {
  sources: string[];
  configuredHostSources: string[];
  missing: string[];
  stale: string[];
};

export function findHostTypeCoverageIssues(rootDir?: string, hostConfigPath?: string): HostTypeCoverageIssues;
export function assertHostTypeCoverage(rootDir?: string, hostConfigPath?: string): void;
export function findTypescriptCompiler(rootDir?: string): string | undefined;
export function runTypeScriptProject(configPath: string, rootDir?: string): number;
