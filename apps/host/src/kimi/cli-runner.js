import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TextDecoder } from 'node:util';

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_STEPS = 10;
const MAX_PROMPT_LENGTH = 8000;
const MAX_OUTPUT_LENGTH = 256 * 1024;

function cleanText(value) {
  return String(value || '').replace(/\r\n/g, '\n').trim();
}

function decodeCliOutput(chunks) {
  const buffer = Buffer.concat(chunks);
  if (buffer.length === 0) {
    return '';
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    if (process.platform === 'win32') {
      try {
        return new TextDecoder('gb18030').decode(buffer);
      } catch {
        // Fall through to Node's replacement decoder.
      }
    }
    return buffer.toString('utf8');
  }
}

function buildMemoryBlock(memory) {
  const text = cleanText(memory).slice(0, 4096);
  if (!text) {
    return '';
  }
  return [
    '工作区记忆 (.AgentCowork/MEMORY.md, 用户已确认的长期事实, 严格遵守):',
    text,
    '工作区记忆结束。',
  ].join('\n');
}

export function buildKimiPlanPrompt({ prompt, summary = '', mode = 'cowork', memory = '' }) {
  const userPrompt = cleanText(prompt);
  if (!userPrompt) {
    throw new Error('prompt is required');
  }
  if (userPrompt.length > MAX_PROMPT_LENGTH) {
    throw new Error(`prompt is too long; max ${MAX_PROMPT_LENGTH} characters`);
  }

  const safeSummary = cleanText(summary).slice(0, 2400);
  const memoryBlock = buildMemoryBlock(memory);
  const lines = [];
  if (memoryBlock) {
    lines.push(memoryBlock);
  }
  lines.push(
    '只基于下面摘要回答，不要读取文件，不要使用工具，不要修改文件，不要运行命令。',
    '用中文 Markdown 输出：目标理解、三条整理建议、审批前本地动作清单。',
    `模式：${mode === 'code' ? 'code' : 'cowork'}`,
    `摘要：${safeSummary || '暂无。'}`,
    `用户指令：${userPrompt}`,
  );
  return lines.join('\n');
}

export function buildKimiChatPrompt({ prompt, summary = '', memory = '' }) {
  const userPrompt = cleanText(prompt);
  if (!userPrompt) {
    throw new Error('prompt is required');
  }
  if (userPrompt.length > MAX_PROMPT_LENGTH) {
    throw new Error(`prompt is too long; max ${MAX_PROMPT_LENGTH} characters`);
  }

  const safeSummary = cleanText(summary).slice(0, 2400);
  const memoryBlock = buildMemoryBlock(memory);
  const lines = [];
  if (memoryBlock) {
    lines.push(memoryBlock);
  }
  lines.push(
    '你是 Agent Cowork 的本地对话核心。',
    '只基于用户消息和 Host 提供的摘要回答；不要读取文件，不要使用工具，不要修改文件，不要运行命令。',
    '如果用户需要本地文件操作，提醒切到“协作”模式并等待审批。',
    `已授权/已上传内容摘要：${safeSummary || '暂无。'}`,
    `用户消息：${userPrompt}`,
  );
  return lines.join('\n');
}

export function buildKimiCliPlanArgs({ trustedRoot, prompt, summary, mode, maxSteps = DEFAULT_MAX_STEPS, model, memory = '' }) {
  if (!trustedRoot || typeof trustedRoot !== 'string') {
    throw new Error('trustedRoot is required');
  }
  const args = [
    '--work-dir',
    trustedRoot,
    '--print',
    '--final-message-only',
    '--max-steps-per-turn',
    String(Math.max(1, Number(maxSteps) || DEFAULT_MAX_STEPS)),
  ];
  if (model) {
    args.push('--model', String(model));
  }
  args.push('--prompt', buildKimiPlanPrompt({ prompt, summary, mode, memory }));
  return args;
}

export function buildKimiCliChatArgs({ trustedRoot, prompt, summary, maxSteps = DEFAULT_MAX_STEPS, model, memory = '' }) {
  if (!trustedRoot || typeof trustedRoot !== 'string') {
    throw new Error('trustedRoot is required');
  }
  const args = [
    '--work-dir',
    trustedRoot,
    '--print',
    '--final-message-only',
    '--max-steps-per-turn',
    String(Math.max(1, Number(maxSteps) || DEFAULT_MAX_STEPS)),
  ];
  if (model) {
    args.push('--model', String(model));
  }
  args.push('--prompt', buildKimiChatPrompt({ prompt, summary, memory }));
  return args;
}

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
} = {}) {
  const startedAt = Date.now();

  // Use a temp work-dir so Kimi CLI does not resume a previous session.
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-kimi-'));
  const args = argsBuilder({ trustedRoot: tempDir, prompt, summary, mode, memory, maxSteps, model });

  return new Promise((resolve, reject) => {
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

    const stdout = [];
    const stderr = [];
    let stdoutLength = 0;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, Math.max(1000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));

    child.stdout.on('data', (chunk) => {
      stdout.push(chunk);
      stdoutLength += chunk.length;
      if (stdoutLength > MAX_OUTPUT_LENGTH) {
        child.kill();
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr.push(chunk);
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      const durationMs = Date.now() - startedAt;
      const output = cleanText(decodeCliOutput(stdout));
      const errorText = cleanText(decodeCliOutput(stderr));

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

export function runKimiCliPlan(options = {}) {
  return runKimiCliText({
    ...options,
    argsBuilder: buildKimiCliPlanArgs,
    resultMode: options.mode === 'code' ? 'code' : 'cowork',
  });
}

export function runKimiCliChat(options = {}) {
  return runKimiCliText({
    ...options,
    argsBuilder: buildKimiCliChatArgs,
    resultMode: 'chat',
  });
}
