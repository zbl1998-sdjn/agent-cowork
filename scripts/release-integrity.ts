// 发布产物完整性:版本匹配、哈希证据与来源清单(scripts · 构建)
// ---------------------------------------------------------------------------
// 职责:提供无副作用的版本校验与 manifest 构造,以及对指定文件的 SHA256/大小取证。
// 依赖:仅 Node fs/path/crypto;不执行 git、构建、签名或安装版验收。
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type ArtifactEvidence = {
  path: string;
  source: string;
  sha256: string;
  bytes: number;
};

export type BundleEvidence = {
  path: string;
  sha256: string | null;
  bytes: number | null;
};

type CreateArtifactEvidenceOptions = {
  sourcePath: string;
  archivedPath: string;
  repoRoot: string;
};

type CreateReleaseManifestOptions = {
  version: string;
  tag: string;
  sourceCommit: string;
  built: string;
  packageName: string;
  bundle: BundleEvidence;
  installers: ArtifactEvidence[];
  runtimeExecutables: ArtifactEvidence[];
  signaturesVerified: boolean;
  updaterArtifacts: ArtifactEvidence[];
  updateManifest: string | null;
  sourceGate: string;
};

type LinkAwareStat = {
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
};

const linkAwareFs = fs as typeof fs & {
  lstatSync(filePath: string): LinkAwareStat;
};

function comparablePath(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isOutside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

function semanticVersionsInFileName(filePath: string): string[] {
  const fileName = path.basename(filePath);
  const pattern = /(?:^|[^0-9A-Za-z])v?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)(?=$|[^0-9A-Za-z])/gi;
  return [...fileName.matchAll(pattern)].map((match) => match[1]).filter((value): value is string => Boolean(value));
}

function hasExactTargetVersion(filePath: string, targetVersion: string): boolean {
  const versions = semanticVersionsInFileName(filePath);
  return versions.length === 1 && versions[0] === targetVersion;
}

function assertTreeContainsNoLinks(directory: string): void {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    const stat = linkAwareFs.lstatSync(entryPath);
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing canonical Tauri bundle cleanup through a symbolic link, junction, or reparse point: ${entryPath}`);
    }
    if (stat.isDirectory()) assertTreeContainsNoLinks(entryPath);
  }
}

function repoRelative(filePath: string, repoRoot: string): string {
  const relative = path.relative(repoRoot, filePath);
  if (!relative || /^\.\.(?:[\\/]|$)/.test(relative) || path.isAbsolute(relative)) {
    throw new Error(`Release artifact must stay inside repository root: ${filePath}`);
  }
  return relative.split(path.sep).join('/');
}

function artifactSnapshot(filePath: string): { sha256: string; bytes: number } {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    throw new Error(`Release artifact is not a file: ${filePath}`);
  }
  const bytes = fs.readFileSync(filePath);
  if (bytes.byteLength !== stat.size) {
    throw new Error(`Release artifact changed while evidence was collected: ${filePath}`);
  }
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.byteLength,
  };
}

export function assertInstallerVersions(installerPaths: readonly string[], targetVersion: string): void {
  if (installerPaths.length === 0) {
    throw new Error(`No canonical installer found for target version ${targetVersion}`);
  }
  for (const installerPath of installerPaths) {
    const fileName = path.basename(installerPath);
    if (!hasExactTargetVersion(installerPath, targetVersion)) {
      throw new Error(
        `Installer ${fileName} must contain exactly one semantic version matching target version ${targetVersion}`,
      );
    }
  }
}

export function assertReleaseVersions(
  versions: Readonly<Record<string, string>>,
  targetVersion: string,
): void {
  for (const [manifest, version] of Object.entries(versions)) {
    if (version !== targetVersion) {
      throw new Error(`${manifest} version ${version} does not match target version ${targetVersion}`);
    }
  }
}

export function assertChangelogVersion(changelog: string, targetVersion: string): void {
  const headings = changelog.split(/\r?\n/).map((line) => {
    const match = /^##\s+(?:\[([^\]]+)\]|([^\s]+))(?:\s+-\s+.+)?\s*$/.exec(line);
    return match?.[1] || match?.[2] || null;
  });
  if (!headings.includes(targetVersion)) {
    throw new Error(`CHANGELOG.md is missing an exact release heading for ${targetVersion}`);
  }
}

export function selectUpdaterArtifacts(
  artifactPaths: readonly string[],
  targetVersion: string,
): string[] {
  return artifactPaths
    .filter((filePath) => /\.(?:nsis|msi)\.zip(?:\.sig)?$/i.test(filePath))
    .filter((filePath) => hasExactTargetVersion(filePath, targetVersion))
    .sort((left, right) => left.localeCompare(right));
}

export function cleanCanonicalBundleRoot(bundleRoot: string, tauriRoot: string): void {
  const resolvedTauriRoot = path.resolve(tauriRoot);
  const expectedBundleRoot = path.resolve(resolvedTauriRoot, 'target', 'release', 'bundle');
  const resolvedBundleRoot = path.resolve(bundleRoot);
  if (comparablePath(resolvedBundleRoot) !== comparablePath(expectedBundleRoot)) {
    throw new Error(`Refusing to clean a non-canonical Tauri bundle path: ${bundleRoot}`);
  }
  if (!fs.existsSync(resolvedTauriRoot)) {
    throw new Error(`Tauri root does not exist: ${resolvedTauriRoot}`);
  }

  const pathChain = [
    resolvedTauriRoot,
    path.join(resolvedTauriRoot, 'target'),
    path.join(resolvedTauriRoot, 'target', 'release'),
    expectedBundleRoot,
  ];
  const realTauriRoot = fs.realpathSync(resolvedTauriRoot);
  for (const candidate of pathChain) {
    if (!fs.existsSync(candidate)) continue;
    const stat = linkAwareFs.lstatSync(candidate);
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing canonical Tauri bundle cleanup through a symbolic link, junction, or reparse point: ${candidate}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`Canonical Tauri bundle path component is not a directory: ${candidate}`);
    }
    const realCandidate = fs.realpathSync(candidate);
    if (isOutside(realCandidate, realTauriRoot)) {
      throw new Error(`Canonical Tauri bundle path escapes the Tauri root: ${candidate}`);
    }
  }

  if (fs.existsSync(expectedBundleRoot)) {
    assertTreeContainsNoLinks(expectedBundleRoot);
    fs.rmSync(expectedBundleRoot, { recursive: true });
  }
}

export function createArtifactEvidence({
  sourcePath,
  archivedPath,
  repoRoot,
}: CreateArtifactEvidenceOptions): ArtifactEvidence {
  const archivedRelativePath = repoRelative(archivedPath, repoRoot);
  const sourceRelativePath = repoRelative(sourcePath, repoRoot);
  const source = artifactSnapshot(sourcePath);
  const archived = comparablePath(sourcePath) === comparablePath(archivedPath)
    ? source
    : artifactSnapshot(archivedPath);
  if (source.bytes !== archived.bytes || source.sha256 !== archived.sha256) {
    throw new Error(
      `Archived artifact differs from source after copy: ${archivedRelativePath} `
      + `(source ${source.bytes} bytes/${source.sha256}, archived ${archived.bytes} bytes/${archived.sha256})`,
    );
  }
  return {
    path: archivedRelativePath,
    source: sourceRelativePath,
    sha256: archived.sha256,
    bytes: archived.bytes,
  };
}

export function createReleaseManifest({
  version,
  tag,
  sourceCommit,
  built,
  packageName,
  bundle,
  installers,
  runtimeExecutables,
  signaturesVerified,
  updaterArtifacts,
  updateManifest,
  sourceGate,
}: CreateReleaseManifestOptions) {
  return {
    schemaVersion: 3,
    version,
    tag,
    commit: sourceCommit,
    built,
    packageName,
    bundle,
    installers,
    runtimeExecutables,
    updaterArtifacts,
    updateManifest,
    provenance: {
      sourceCommit,
      generatedBy: 'scripts/release.ts',
      sourceGate,
      signaturesVerified,
      runtime: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
      },
    },
    acceptance: {
      localSourceGateOnly: true,
      requiredExternal: [
        'installed-tauri-smoke',
        'trusted-code-signing-verification',
        'production-updater-verification',
      ],
    },
  };
}
