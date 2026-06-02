// Git runner helpers(host · L1 领域层 · tools/dev)
// ---------------------------------------------------------------------------
// 职责:封装 git 子进程执行、可信工作区解析、路径 jail 与输出截断。

import { execFile } from 'node:child_process';
import path from 'node:path';
import { assertTrustedPath, assertTrustedPathForCreate } from '../../security/path-policy.js';

type GitExecError = Error & { code?: number | string; stdout?: unknown; stderr?: unknown };
type ResolvedWorkspace = { root: string; workspace: string };
type RunGitOptions = { trustedRoot?: unknown; workspace?: unknown; args: readonly string[] };
type ExecFileResult = { stdout: string | Buffer; stderr: string | Buffer };
type ExecFileOptions = { cwd: string; windowsHide: boolean; maxBuffer: number; timeout: number };

export type ToolContext = { trustedRoot?: unknown; context?: unknown };
export type GitRunResult = { ok: boolean; exitCode: number; workspace: string; stdout: string; stderr: string };

const MAX_OUTPUT_BYTES = 12000;

function execFileAsync(command: string, args: readonly string[], options: ExecFileOptions): Promise<ExecFileResult> {
  return new Promise((resolve, reject) => {
    execFile(command, Array.from(args), options, (error, stdout, stderr) => {
      if (error) {
        const execError = error as GitExecError;
        execError.stdout ??= stdout;
        execError.stderr ??= stderr;
        reject(execError);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function clip(text: unknown, max = MAX_OUTPUT_BYTES): string {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max)}\n...(truncated ${s.length - max} chars)` : s;
}

export function intInRange(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

/** 把 workspace 锚定并校验进可信根,返回绝对路径;越界即抛错。 */
export function resolveWorkspace(trustedRoot: unknown, workspace: unknown = '.'): ResolvedWorkspace {
  if (!trustedRoot) throw new Error('trustedRoot is required');
  const trustedRootText = String(trustedRoot);
  const root = assertTrustedPath(path.resolve(trustedRootText), path.resolve(trustedRootText));
  const workspaceText = String(workspace || '.');
  const target = assertTrustedPath(path.isAbsolute(workspaceText) ? workspaceText : path.join(root, workspaceText), root);
  return { root, workspace: target };
}

export function resolveGitPath(root: string, workspace: string, relPath: unknown): string | null {
  if (!relPath) return null;
  const full = assertTrustedPathForCreate(path.join(workspace, String(relPath)), root);
  return path.relative(workspace, full).replace(/\\/g, '/');
}

/** 在校验过的工作区内执行 git,统一截断 stdout/stderr 并归一化退出码。 */
export async function runGit({ trustedRoot, workspace = '.', args }: RunGitOptions): Promise<GitRunResult> {
  const resolved = resolveWorkspace(trustedRoot, workspace);
  const argv = ['-c', `safe.directory=${resolved.workspace}`, '-C', resolved.workspace, ...args];
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
    const error = err as GitExecError;
    return {
      ok: false,
      exitCode: typeof error.code === 'number' ? error.code : 1,
      workspace: path.relative(resolved.root, resolved.workspace).replace(/\\/g, '/') || '.',
      stdout: clip(error.stdout),
      stderr: clip(error.stderr || error.message, 4000),
    };
  }
}
