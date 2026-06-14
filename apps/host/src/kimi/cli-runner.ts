// Kimi CLI 调用(host · L1 领域层)
// ---------------------------------------------------------------------------
// 职责:在隔离临时目录中以子进程方式调用本地 Kimi CLI,拼装 plan/chat 模式的
//       提示词与命令行参数,做超时/输出上限/编码(UTF-8↔GB18030)处理后返回纯文本。
// 依赖:node:child_process/fs/os/path/util(均标准库);不依赖网络。
// 导出:buildKimiPlanPrompt / buildKimiChatPrompt / buildKimiCliPlanArgs /
//       buildKimiCliChatArgs / runKimiCliPlan / runKimiCliChat。
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decodeCliOutput } from './cli-output.js';
import { buildKimiCliChatArgs, buildKimiCliPlanArgs } from './cli-runner-prompts.js';
import type { CliArgsOptions, PromptOptions } from './cli-runner-prompts.js';

export {
  buildKimiChatPrompt,
  buildKimiCliChatArgs,
  buildKimiCliPlanArgs,
  buildKimiPlanPrompt,
} from './cli-runner-prompts.js';

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_STEPS = 10;
const MAX_OUTPUT_LENGTH = 256 * 1024;

type RunTextOptions = PromptOptions & {
  command?: string;
  argsBuilder?: (options: CliArgsOptions) => string[];
  timeoutMs?: unknown;
  maxSteps?: unknown;
  model?: unknown;
  resultMode?: string;
};
type KimiCliResult = {
  ok: true;
  provider: 'kimi-cli';
  command: string;
  mode: string;
  text: string;
  durationMs: number;
};

/** 通用执行器:在临时工作目录里 spawn Kimi CLI,带超时与输出上限,返回标准化结果。 */
function runKimiCliText({
  command = 'kimi',
  argsBuilder,
  prompt,
  summary,
  mode,
  memory = '',
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxSteps = DEFAULT_MAX_STEPS,
  model,
  resultMode,
}: RunTextOptions = {}): Promise<KimiCliResult> {
  const startedAt = Date.now();
  if (typeof argsBuilder !== 'function') {
    throw new Error('argsBuilder is required');
  }

  // 使用临时工作目录,避免 Kimi CLI 续接上一轮会话状态。
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-kimi-'));
  const args = argsBuilder({ trustedRoot: tempDir, prompt, summary, mode, memory, maxSteps, model });

  return new Promise<KimiCliResult>((resolve, reject) => {
    const child = childProcess.spawn(command, args, {
      cwd: tempDir,
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
      },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutLength = 0;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, Math.max(1000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));

    child.stdout.on('data', (chunk: unknown) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      stdout.push(buffer);
      stdoutLength += buffer.length;
      if (stdoutLength > MAX_OUTPUT_LENGTH) {
        child.kill();
      }
    });
    child.stderr.on('data', (chunk: unknown) => {
      stderr.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    });
    child.on('error', (error: Error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code: number | null) => {
      clearTimeout(timeout);
      const durationMs = Date.now() - startedAt;
      const output = decodeCliOutput(stdout).replace(/\r\n/g, '\n').trim();
      const errorText = decodeCliOutput(stderr).replace(/\r\n/g, '\n').trim();

      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }

      if (timedOut) {
        reject(new Error(`Kimi CLI timed out after ${timeoutMs}ms`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`Kimi CLI exited ${code}: ${errorText || output}`));
        return;
      }
      if (!output) {
        reject(new Error('Kimi CLI returned empty output'));
        return;
      }

      resolve({
        ok: true,
        provider: 'kimi-cli',
        command: path.basename(command),
        mode: resultMode || (mode === 'code' ? 'code' : 'cowork'),
        text: output,
        durationMs,
      });
    });
  });
}

/** 以计划模式调用 Kimi CLI。 */
export function runKimiCliPlan(options: Omit<RunTextOptions, 'argsBuilder' | 'resultMode'> = {}): Promise<KimiCliResult> {
  return runKimiCliText({
    ...options,
    argsBuilder: buildKimiCliPlanArgs,
    resultMode: options.mode === 'code' ? 'code' : 'cowork',
  });
}

/** 以对话模式调用 Kimi CLI。 */
export function runKimiCliChat(options: Omit<RunTextOptions, 'argsBuilder' | 'resultMode'> = {}): Promise<KimiCliResult> {
  return runKimiCliText({
    ...options,
    argsBuilder: buildKimiCliChatArgs,
    resultMode: 'chat',
  });
}
