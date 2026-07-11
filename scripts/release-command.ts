// 发布子进程参数策略:Windows 下绕过 cmd.exe 字符串解析(scripts · 构建)
// ---------------------------------------------------------------------------
// 职责:为 release.ts 生成 shell=false 的命令与参数数组。npm 在 Windows 上通常
//   是 npm.cmd，因此改由当前 Node 直接执行 npm-cli.js；其他发布工具直接启动。
// 依赖:仅 Node fs/path/process，不执行任何命令。
import fs from 'node:fs';
import path from 'node:path';

export type ReleaseCommandSpec = {
  command: string;
  args: string[];
};

// The full gate contains a 45-minute Tauri build step plus preceding audits,
// builds, smoke tests, and CI. Its caller must not time out first.
export const FULL_SOURCE_GATE_TIMEOUT_MS = 7_200_000;

type ReleaseCommandOptions = {
  platform?: string;
  nodeExecPath?: string;
  npmExecPath?: string | null;
};

function isNpmCliFile(filePath: string | null | undefined): filePath is string {
  return Boolean(filePath && /npm-cli\.(?:c?js|mjs)$/i.test(filePath) && fs.existsSync(filePath));
}

function resolveNpmCli(options: ReleaseCommandOptions): string | null {
  if (options.npmExecPath !== undefined) {
    return isNpmCliFile(options.npmExecPath) ? options.npmExecPath : null;
  }
  if (isNpmCliFile(process.env.npm_execpath)) return process.env.npm_execpath;
  const nodeExecPath = options.nodeExecPath || process.execPath;
  const bundledCandidate = path.join(path.dirname(nodeExecPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  return isNpmCliFile(bundledCandidate) ? bundledCandidate : null;
}

export function buildReleaseCommandSpec(
  command: string,
  args: readonly string[],
  options: ReleaseCommandOptions = {},
): ReleaseCommandSpec {
  const platform = options.platform || process.platform;
  if (platform !== 'win32') return { command, args: [...args] };

  if (/^npm(?:\.cmd)?$/i.test(command)) {
    const npmCli = resolveNpmCli(options);
    if (!npmCli) {
      throw new Error(
        'Unable to resolve the npm CLI entry point for safe Windows execution. '
        + 'Run the release through `npm run release` or install npm beside Node.',
      );
    }
    return {
      command: options.nodeExecPath || process.execPath,
      args: [npmCli, ...args],
    };
  }

  if (/\.(?:cmd|bat)$/i.test(command)) {
    throw new Error(`Refusing shell-script command in the release pipeline: ${command}`);
  }
  return { command, args: [...args] };
}
