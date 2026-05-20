import childProcess from 'node:child_process';
import { assertTrustedPath } from '../security/path-policy.js';

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_OUTPUT_BYTES = 8192;

function parseCommand(cmd) {
  if (typeof cmd !== 'string' || !cmd.trim()) {
    throw new Error('command is required');
  }
  const [command, ...args] = cmd.trim().split(/\s+/);
  return { command, args };
}

function toLimitedString(parts, maxBytes) {
  const buffer = Buffer.concat(parts);
  if (buffer.length <= maxBytes) {
    return buffer.toString('utf8');
  }
  return buffer.subarray(0, maxBytes).toString('utf8');
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

  const outParts = [];
  const errParts = [];
  let timeout;
  let timedOut = false;
  child.stdout.on('data', (chunk) => {
    if (Buffer.isBuffer(chunk)) {
      outParts.push(chunk);
    }
  });
  child.stderr.on('data', (chunk) => {
    if (Buffer.isBuffer(chunk)) {
      errParts.push(chunk);
    }
  });

  const result = new Promise((resolve, reject) => {
    child.on('error', (err) => reject(err));
    child.on('close', (code, signal) => {
      const outputBuffer = Buffer.concat(outParts);
      const errorBuffer = Buffer.concat(errParts);
      const output = toLimitedString([outputBuffer], maxOutputBytes);
      const errorOutput = toLimitedString([errorBuffer], maxOutputBytes);
      const timeoutTruncated = timedOut;
      resolve({
        exitCode: code === null ? -1 : code,
        signal,
        stdout: output,
        stderr: errorOutput,
        timedOut,
        truncated: outputBuffer.length > maxOutputBytes || errorBuffer.length > maxOutputBytes || timeoutTruncated,
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
