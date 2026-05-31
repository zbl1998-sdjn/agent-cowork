// Git 工具(host · L1 领域层 · tools/dev)
// ---------------------------------------------------------------------------
// 职责:把 git 暴露成受控工具。status/diff/log 为只读;GitCommit 为高危写操作(需审批)。
//       所有命令限定在「可信工作区」内运行(经 path-policy 校验),参数白名单化、输出截断、
//       带 15s 超时与 safe.directory,杜绝任意参数注入与越界。
// 依赖:node:child_process/path/util + L0 security/path-policy。
// 导出:createGitStatusTool/DiffTool/LogTool/CommitTool + createGitReadOnlyBuiltinTools(只读三件套)。

import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { assertTrustedPath, assertTrustedPathForCreate } from '../../security/path-policy.js';

/**
 * @typedef {Error & { code?: number | string, stdout?: unknown, stderr?: unknown }} GitExecError
 * @typedef {{ root: string, workspace: string }} ResolvedWorkspace
 * @typedef {{ trustedRoot?: string, context?: unknown }} ToolContext
 * @typedef {{ workspace?: unknown, short?: unknown, branch?: unknown, path?: unknown, staged?: unknown, stat?: unknown, context?: unknown, maxCount?: unknown, message?: unknown, all?: unknown, paths?: unknown }} GitToolArgs
 * @typedef {{ trustedRoot?: unknown, workspace?: unknown, args: string[] }} RunGitOptions
 * @typedef {{ ok: boolean, exitCode: number, workspace: string, stdout: string, stderr: string }} GitRunResult
 */

/** @type {(command: string, args: string[], options: Record<string, unknown>) => Promise<{ stdout?: unknown, stderr?: unknown }>} */
const execFileAsync = promisify(execFile);
const MAX_OUTPUT_BYTES = 12000;

/** @param {unknown} text @param {number} [max] */
function clip(text, max = MAX_OUTPUT_BYTES) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max)}\n...(truncated ${s.length - max} chars)` : s;
}

/** @param {unknown} value @param {number} fallback @param {number} min @param {number} max */
function intInRange(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

/** 把 workspace 锚定并校验进可信根,返回 { root, workspace } 绝对路径(越界即抛错)。 @param {unknown} trustedRoot @param {unknown} [workspace] @returns {ResolvedWorkspace} */
function resolveWorkspace(trustedRoot, workspace = '.') {
  if (!trustedRoot) throw new Error('trustedRoot is required');
  const trustedRootText = String(trustedRoot);
  const root = assertTrustedPath(path.resolve(trustedRootText), path.resolve(trustedRootText));
  const workspaceText = String(workspace || '.');
  const target = assertTrustedPath(path.isAbsolute(workspaceText) ? workspaceText : path.join(root, workspaceText), root);
  return { root, workspace: target };
}

/** @param {string} root @param {string} workspace @param {unknown} relPath */
function resolveGitPath(root, workspace, relPath) {
  if (!relPath) return null;
  const full = assertTrustedPathForCreate(path.join(workspace, String(relPath)), root);
  return path.relative(workspace, full).replace(/\\/g, '/');
}

/** 在校验过的工作区内执行一条 git 命令,统一截断 stdout/stderr 并归一化退出码。 @param {RunGitOptions} options @returns {Promise<GitRunResult>} */
async function runGit({ trustedRoot, workspace = '.', args }) {
  const resolved = resolveWorkspace(trustedRoot, workspace);
  const argv = [
    '-c',
    `safe.directory=${resolved.workspace}`,
    '-C',
    resolved.workspace,
    ...args,
  ];
  try {
    const result = await execFileAsync('git', argv, {
      cwd: resolved.workspace,
      windowsHide: true,
      maxBuffer: MAX_OUTPUT_BYTES * 4,
      timeout: 15000,
    });
    return {
      ok: true,
      exitCode: 0,
      workspace: path.relative(resolved.root, resolved.workspace).replace(/\\/g, '/') || '.',
      stdout: clip(result.stdout),
      stderr: clip(result.stderr, 4000),
    };
  } catch (err) {
    const error = /** @type {GitExecError} */ (err);
    return {
      ok: false,
      exitCode: typeof error.code === 'number' ? error.code : 1,
      workspace: path.relative(resolved.root, resolved.workspace).replace(/\\/g, '/') || '.',
      stdout: clip(error.stdout),
      stderr: clip(error.stderr || error.message, 4000),
    };
  }
}

/** git.status 只读工具:porcelain/short 状态,可选分支信息。 */
export function createGitStatusTool() {
  return {
    name: 'git.status',
    description: '只读：查看 trusted workspace 内 git 状态，默认 porcelain 输出，可选 branch 信息。',
    source: 'builtin',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: { type: 'string' },
        short: { type: 'boolean' },
        branch: { type: 'boolean' },
      },
    },
    handler: async (args = {}, ctx = {}) => {
      const input = /** @type {GitToolArgs} */ (args);
      const context = /** @type {ToolContext} */ (ctx);
      const statusArgs = ['status', input.short === true ? '--short' : '--porcelain=v1'];
      if (input.branch === true) statusArgs.push('--branch');
      return runGit({ trustedRoot: context.trustedRoot, workspace: input.workspace, args: statusArgs });
    },
  };
}

/** git.diff 只读工具:参数白名单仅 staged/stat/context/path。 */
export function createGitDiffTool() {
  return {
    name: 'git.diff',
    description: '只读：查看 trusted workspace 内 git diff；参数仅允许 staged/stat/context/path。',
    source: 'builtin',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: { type: 'string' },
        path: { type: 'string' },
        staged: { type: 'boolean' },
        stat: { type: 'boolean' },
        context: { type: 'number' },
      },
    },
    handler: async (args = {}, ctx = {}) => {
      const input = /** @type {GitToolArgs} */ (args);
      const context = /** @type {ToolContext} */ (ctx);
      const { root, workspace } = resolveWorkspace(context.trustedRoot, input.workspace);
      const diffArgs = ['diff', `--unified=${intInRange(input.context, 3, 0, 20)}`];
      if (input.staged === true) diffArgs.push('--cached');
      if (input.stat === true) diffArgs.push('--stat');
      const relPath = resolveGitPath(root, workspace, input.path);
      if (relPath) diffArgs.push('--', relPath);
      return runGit({ trustedRoot: root, workspace, args: diffArgs });
    },
  };
}

/** git.log 只读工具:oneline 最近提交,参数仅 maxCount/path。 */
export function createGitLogTool() {
  return {
    name: 'git.log',
    description: '只读：查看 trusted workspace 内最近提交；参数仅允许 maxCount/path。',
    source: 'builtin',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: { type: 'string' },
        maxCount: { type: 'number' },
        path: { type: 'string' },
      },
    },
    handler: async (args = {}, ctx = {}) => {
      const input = /** @type {GitToolArgs} */ (args);
      const context = /** @type {ToolContext} */ (ctx);
      const { root, workspace } = resolveWorkspace(context.trustedRoot, input.workspace);
      const logArgs = ['log', '--oneline', '--decorate=short', `--max-count=${intInRange(input.maxCount, 10, 1, 50)}`];
      const relPath = resolveGitPath(root, workspace, input.path);
      if (relPath) logArgs.push('--', relPath);
      return runGit({ trustedRoot: root, workspace, args: logArgs });
    },
  };
}

/** GitCommit 高危写工具:add(all 或 paths 白名单)后提交;message 必填且限长,必经审批。 */
export function createGitCommitTool() {
  return {
    name: 'GitCommit',
    mutating: true,
    risk: 'high',
    description: '高风险：在 trusted workspace 内创建 git commit。不会静默运行；必须经审批。只允许 message、all 或 paths 白名单参数。',
    parameters: {
      type: 'object',
      properties: {
        workspace: { type: 'string' },
        message: { type: 'string' },
        all: { type: 'boolean' },
        paths: { type: 'array', items: { type: 'string' } },
      },
      required: ['message'],
    },
    handler: async (args = {}, ctx = {}) => {
      const input = /** @type {GitToolArgs} */ (args);
      const context = /** @type {ToolContext} */ (ctx);
      const message = String(input.message || '').trim();
      if (!message) throw new Error('message is required');
      if (message.length > 500) throw new Error('message is too long');
      const { root, workspace } = resolveWorkspace(context.trustedRoot, input.workspace);
      const rawPaths = Array.isArray(input.paths) ? input.paths.filter(Boolean) : [];
      if (input.all === true && rawPaths.length) throw new Error('use either all=true or paths, not both');
      if (rawPaths.length > 100) throw new Error('too many paths');
      const paths = /** @type {string[]} */ (rawPaths.map((p) => resolveGitPath(root, workspace, p)));
      const addArgs = input.all === true
        ? ['add', '-A', '--', '.']
        : paths.length
          ? ['add', '--', ...paths]
          : null;
      if (addArgs) {
        const add = await runGit({ trustedRoot: root, workspace, args: addArgs });
        if (!add.ok) return { ...add, stage: 'add' };
      }
      const commit = await runGit({ trustedRoot: root, workspace, args: ['commit', '-m', message] });
      return { ...commit, stage: 'commit' };
    },
  };
}

/** 只读 Git 工具三件套(status/diff/log),供 builtin-tools 默认挂载(写操作 GitCommit 另行按需启用)。 */
export function createGitReadOnlyBuiltinTools() {
  return [createGitStatusTool(), createGitDiffTool(), createGitLogTool()];
}
