// 命令运行(host · L1 领域层 · workspace)
// ---------------------------------------------------------------------------
// 职责:在工作区内运行外部命令——默认「禁用」(allowCommands 显式开启才放行),cwd 限定可信根、
//       无 shell、硬超时(SIGKILL)、输出限额。默认最小权限(plan/01 D.13)。
// 依赖:L0 path-policy + sandbox/exec-child(限额缓冲)。导出:runCommand。
import childProcess from 'node:child_process';
import { assertTrustedPath } from '../security/path-policy.js';
import { createCappedBuffer } from '../sandbox/exec-child.js';

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_OUTPUT_BYTES = 8192;

export type CommandInput = {
  command?: string;
  args?: string[];
  allowCommands?: boolean;
  timeoutMs?: number;
  maxOutputBytes?: number;
  trustedRoot?: string;
  cwd?: string;
};
type ParsedCommand = { command: string; args: string[] };
export type CommandResult = {
  exitCode: number;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  error?: string;
};

function parseCommand(cmd: unknown): ParsedCommand {
  if (typeof cmd !== 'string' || !cmd.trim()) {
    throw new Error('command is required');
  }
  const [command, ...args] = cmd.trim().split(/\s+/);
  return { command, args };
}

/** 运行命令:未开 allowCommands 直接拒绝;cwd 校验在可信根内,无 shell 执行,超时 SIGKILL,输出限额。 */
export async function runCommand(input: CommandInput = {}): Promise<CommandResult> {
  const options = input || {};
  const allowCommands = options.allowCommands === true;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const trustedRoot = options.trustedRoot;
  const cwd = options.cwd || process.cwd();

  if (!allowCommands) {
    throw new Error('Command execution is disabled');
  }
  if (!trustedRoot) {
    throw new Error('trustedRoot is required');
  }

  const parsed = options.args ? { command: options.command, args: options.args } : parseCommand(options.command);
  if (!parsed.command) {
    throw new Error('command is required');
  }

  const safeCwd = assertTrustedPath(cwd, trustedRoot);
  const commandArgs = parsed.args ?? [];
  const child = childProcess.spawn(parsed.command, commandArgs, {
    cwd: safeCwd,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Stream into memory-bounded sinks so a high-output command can never grow
  // the heap past the cap before the timeout fires (see createCappedBuffer).
  const out = createCappedBuffer(maxOutputBytes);
  const err = createCappedBuffer(maxOutputBytes);
  let timedOut = false;
  const timeout = setTimeout((): void => {
    timedOut = true;
    child.kill('SIGKILL');
  }, timeoutMs);
  child.stdout.on('data', (chunk) => out.push(chunk));
  child.stderr.on('data', (chunk) => err.push(chunk));

  const result = new Promise<CommandResult>((resolve, reject) => {
    child.on('error', (e) => reject(e));
    child.on('close', (code, signal) => {
      resolve({
        exitCode: code === null ? -1 : code,
        signal,
        stdout: out.text,
        stderr: err.text,
        timedOut,
        truncated: out.truncated || err.truncated || timedOut,
      });
    });
  });
  const commandResult = await result.finally(() => clearTimeout(timeout));
  if (timedOut) {
    commandResult.error = `Command timed out after ${timeoutMs}ms`;
  }
  return commandResult;
}
