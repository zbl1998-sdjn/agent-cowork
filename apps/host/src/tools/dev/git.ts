// Git 工具(host · L1 领域层 · tools/dev)
// ---------------------------------------------------------------------------
// 职责:把 git 暴露成受控工具。status/diff/log 为只读;GitCommit 为高危写操作(需审批)。
//       所有命令限定在「可信工作区」内运行,参数白名单化、输出截断并使用 safe.directory。
// 依赖:同层 git-inputs/git-runner。导出:Git 工具工厂与只读三件套。

import { parseGitDiffArgs, parseGitLogArgs, parseGitStatusArgs, parseGitWriteArgs } from './git-inputs.js';
import { intInRange, resolveGitPath, resolveWorkspace, runGit } from './git-runner.js';
import type { ToolContext } from './git-runner.js';

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
    handler: async (args: unknown = {}, ctx: ToolContext = {}) => {
      const input = parseGitStatusArgs(args);
      const statusArgs = ['status', input.short === true ? '--short' : '--porcelain=v1'];
      if (input.branch === true) statusArgs.push('--branch');
      return runGit({ trustedRoot: ctx.trustedRoot, workspace: input.workspace, args: statusArgs });
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
    handler: async (args: unknown = {}, ctx: ToolContext = {}) => {
      const input = parseGitDiffArgs(args);
      const { root, workspace } = resolveWorkspace(ctx.trustedRoot, input.workspace);
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
    handler: async (args: unknown = {}, ctx: ToolContext = {}) => {
      const input = parseGitLogArgs(args);
      const { root, workspace } = resolveWorkspace(ctx.trustedRoot, input.workspace);
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
    description: '高风险：在 trusted workspace 内创建 git commit。不会静默运行；必须经审批。',
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
    handler: async (args: unknown = {}, ctx: ToolContext = {}) => {
      const input = parseGitWriteArgs('GitCommit', args);
      const { root, workspace } = resolveWorkspace(ctx.trustedRoot, input.workspace);
      const rawPaths = input.paths ?? [];
      if (input.all === true && rawPaths.length) throw new Error('use either all=true or paths, not both');
      const paths = rawPaths
        .map((p) => resolveGitPath(root, workspace, p))
        .filter((value): value is string => value !== null);
      const addArgs = input.all === true
        ? ['add', '-A', '--', '.']
        : paths.length
          ? ['add', '--', ...paths]
          : null;
      if (addArgs) {
        const add = await runGit({ trustedRoot: root, workspace, args: addArgs });
        if (!add.ok) return { ...add, stage: 'add' };
      }
      const commit = await runGit({ trustedRoot: root, workspace, args: ['commit', '-m', input.message] });
      return { ...commit, stage: 'commit' };
    },
  };
}

/** 只读 Git 工具三件套(status/diff/log),供 builtin-tools 默认挂载。 */
export function createGitReadOnlyBuiltinTools() {
  return [createGitStatusTool(), createGitDiffTool(), createGitLogTool()];
}
