// 本地子进程沙箱(host · L1 领域层 · sandbox)
// ---------------------------------------------------------------------------
// 职责:把归一化 SandboxSpec 作为「受约束子进程」在宿主机上运行:无 shell(argv 数组不可注入)、
//       cwd 限定可信根、env 白名单、硬超时(SIGKILL)+ 输出字节上限。
// 诚实声明:普通宿主子进程「无法」做网络隔离,故始终 networkIsolated:false,要求关网时给出警告;
//       真隔离交给 VM 适配器(WSL2/Docker),两者共享同一 exec(spec,ctx) 契约。
// 依赖:L0 path-policy + 同层 exec-child。导出:LocalSubprocessSandbox。
import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { assertTrustedPath } from '../security/path-policy.js';
import { runConstrainedChild } from './exec-child.js';
import type { RunChildResult, SpawnLike } from './exec-child.js';
import type { SandboxSpec } from './sandbox-spec.js';

export type SandboxExecContext = { trustedRoot?: string; context?: Record<string, unknown>; signal?: AbortSignal | null };
export type SandboxExecResult = RunChildResult & {
  backend: string;
  networkIsolated: boolean;
  warnings: string[];
};

type StatusError = Error & { statusCode?: number };

function fail(message: string, statusCode = 400): StatusError {
  const error = new Error(message) as StatusError;
  error.statusCode = statusCode;
  return error;
}

function commandForSpec(spec: SandboxSpec): string {
  if (spec.executablePath == null) return spec.tool;
  if (typeof spec.executablePath !== 'string' || spec.executablePath.includes('\0') || !path.isAbsolute(spec.executablePath)) {
    throw fail('LocalSubprocessSandbox.exec: executablePath must be an absolute path without NUL bytes');
  }
  const configuredPath = path.resolve(spec.executablePath);
  const configuredTool = path.basename(configuredPath);
  const namesMatch = (actualTool: string): boolean => process.platform === 'win32'
    ? actualTool.toLowerCase() === spec.tool.toLowerCase()
    : actualTool === spec.tool;
  if (!namesMatch(configuredTool)) {
    throw fail('LocalSubprocessSandbox.exec: executablePath basename must match tool');
  }
  let command: string;
  let isFile: boolean;
  try {
    command = fs.realpathSync(configuredPath);
    isFile = fs.statSync(command).isFile();
  } catch {
    throw fail('LocalSubprocessSandbox.exec: executablePath must resolve to an existing file');
  }
  if (!isFile) {
    throw fail('LocalSubprocessSandbox.exec: executablePath must resolve to a regular file');
  }
  if (!namesMatch(path.basename(command))) {
    throw fail('LocalSubprocessSandbox.exec: executablePath realpath basename must match tool');
  }
  return command;
}

/** 本地子进程沙箱适配器:在宿主机上运行受约束子进程(无网络隔离)。 */
export class LocalSubprocessSandbox {
  backend: string;
  networkIsolated: boolean;
  private _spawn: SpawnLike;

  constructor({ spawn = childProcess.spawn as SpawnLike }: { spawn?: SpawnLike } = {}) {
    this.backend = 'local-subprocess';
    this.networkIsolated = false;
    this._spawn = spawn;
  }

  /** 执行一条规格:校验 cwd 在可信根内,拼装 env(并入 PATH 等),交受约束子进程运行并回传结果+警告。 */
  async exec(spec: SandboxSpec, ctx: SandboxExecContext = {}): Promise<SandboxExecResult> {
    if (spec.unrestrictedHostExecution !== true) {
      throw fail(
        'local-subprocess cannot enforce workspace or host isolation; use Docker, or explicitly request unrestrictedHostExecution with an allowed capability',
        501,
      );
    }
    const trustedRoot = ctx.trustedRoot;
    if (!trustedRoot) {
      throw new Error('LocalSubprocessSandbox.exec: trustedRoot is required');
    }
    const requestedCwd = spec.cwd ? spec.cwd : trustedRoot;
    const safeCwd = assertTrustedPath(requestedCwd, trustedRoot);
    const command = commandForSpec(spec);

    const warnings: string[] = [
      'unrestricted host execution is enabled; this process is not a read-only or OS-isolated sandbox',
    ];
    if (!spec.network) {
      warnings.push('local backend cannot enforce network isolation; use the vm backend for a true no-network guarantee');
    }

    const env: Record<string, string> = { ...spec.env };
    if (process.env.PATH) {
      env.PATH = env.PATH ? `${env.PATH}${path.delimiter}${process.env.PATH}` : process.env.PATH;
    }
    if (process.env.PATHEXT) env.PATHEXT = process.env.PATHEXT;
    if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;

    const core = await runConstrainedChild({
      spawn: this._spawn,
      command,
      args: spec.args,
      cwd: safeCwd,
      env,
      timeoutMs: spec.timeoutMs,
      maxOutputBytes: spec.maxOutputBytes,
      abortSignal: ctx.signal ?? null,
    });

    return {
      backend: this.backend,
      ...core,
      networkIsolated: false,
      warnings,
    };
  }
}
