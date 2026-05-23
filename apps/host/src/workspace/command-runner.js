import childProcess from 'node:child_process';
import { assertTrustedPath } from '../security/path-policy.js';
import { createCappedBuffer } from '../sandbox/exec-child.js';

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_OUTPUT_BYTES = 8192;

function parseCommand(cmd) {
  if (typeof cmd !== 'string' || !cmd.trim()) {
    throw new Error('command is required');
  }
  const [command, ...args] = cmd.trim().split(/\s+/);
  return { command, args };
}

export async function runCommand(input) {
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

  const parsed = input.args ? { command: options.command, args: options.args } : parseCommand(options.command);
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
  let timeout;
  let timedOut = false;
  child.stdout.on('data', (chunk) => out.push(chunk));
  child.stderr.on('data', (chunk) => err.push(chunk));

  const result = new Promise((resolve, reject) => {
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
  timeout = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, timeoutMs);

  const commandResult = await result.finally(() => clearTimeout(timeout));
  if (timedOut) {
    commandResult.error = `Command timed out after ${timeoutMs}ms`;
  }
  return commandResult;
}
