import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { assertTrustedPath, assertTrustedPathForCreate } from '../../security/path-policy.js';

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_BYTES = 12000;

function clip(text, max = MAX_OUTPUT_BYTES) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max)}\n...(truncated ${s.length - max} chars)` : s;
}

function intInRange(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

function resolveWorkspace(trustedRoot, workspace = '.') {
  if (!trustedRoot) throw new Error('trustedRoot is required');
  const root = assertTrustedPath(path.resolve(trustedRoot), path.resolve(trustedRoot));
  const workspaceText = String(workspace || '.');
  const target = assertTrustedPath(path.isAbsolute(workspaceText) ? workspaceText : path.join(root, workspaceText), root);
  return { root, workspace: target };
}

function resolveGitPath(root, workspace, relPath) {
  if (!relPath) return null;
  const full = assertTrustedPathForCreate(path.join(workspace, String(relPath)), root);
  return path.relative(workspace, full).replace(/\\/g, '/');
}

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
    return {
      ok: false,
      exitCode: typeof err.code === 'number' ? err.code : 1,
      workspace: path.relative(resolved.root, resolved.workspace).replace(/\\/g, '/') || '.',
      stdout: clip(err.stdout),
      stderr: clip(err.stderr || err.message, 4000),
    };
  }
}

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
      const statusArgs = ['status', args.short === true ? '--short' : '--porcelain=v1'];
      if (args.branch === true) statusArgs.push('--branch');
      return runGit({ trustedRoot: ctx.trustedRoot, workspace: args.workspace, args: statusArgs });
    },
  };
}

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
      const { root, workspace } = resolveWorkspace(ctx.trustedRoot, args.workspace);
      const diffArgs = ['diff', `--unified=${intInRange(args.context, 3, 0, 20)}`];
      if (args.staged === true) diffArgs.push('--cached');
      if (args.stat === true) diffArgs.push('--stat');
      const relPath = resolveGitPath(root, workspace, args.path);
      if (relPath) diffArgs.push('--', relPath);
      return runGit({ trustedRoot: root, workspace, args: diffArgs });
    },
  };
}

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
      const { root, workspace } = resolveWorkspace(ctx.trustedRoot, args.workspace);
      const logArgs = ['log', '--oneline', '--decorate=short', `--max-count=${intInRange(args.maxCount, 10, 1, 50)}`];
      const relPath = resolveGitPath(root, workspace, args.path);
      if (relPath) logArgs.push('--', relPath);
      return runGit({ trustedRoot: root, workspace, args: logArgs });
    },
  };
}

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
      const message = String(args.message || '').trim();
      if (!message) throw new Error('message is required');
      if (message.length > 500) throw new Error('message is too long');
      const { root, workspace } = resolveWorkspace(ctx.trustedRoot, args.workspace);
      const rawPaths = Array.isArray(args.paths) ? args.paths.filter(Boolean) : [];
      if (args.all === true && rawPaths.length) throw new Error('use either all=true or paths, not both');
      if (rawPaths.length > 100) throw new Error('too many paths');
      const paths = rawPaths.map((p) => resolveGitPath(root, workspace, p));
      const addArgs = args.all === true
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

export function createGitReadOnlyBuiltinTools() {
  return [createGitStatusTool(), createGitDiffTool(), createGitLogTool()];
}
