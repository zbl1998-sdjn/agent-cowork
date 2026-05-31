// Kimi CLI prompt/args helpers(host · L1 领域层):纯字符串拼装,无进程副作用。

const DEFAULT_MAX_STEPS = 10;
const MAX_PROMPT_LENGTH = 8000;

export type PromptOptions = { prompt?: unknown; summary?: unknown; mode?: unknown; memory?: unknown };
export type CliArgsOptions = PromptOptions & { trustedRoot?: unknown; maxSteps?: unknown; model?: unknown };

/** 归一换行并去首尾空白。 */
function cleanText(value: unknown): string {
  return String(value || '').replace(/\r\n/g, '\n').trim();
}

/** 把工作区长期记忆裁剪成提示词里的「记忆块」(空则返回空串)。 */
function buildMemoryBlock(memory: unknown): string {
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

/** 拼装「计划模式」提示词:基于摘要给出目标理解 + 整理建议 + 审批前动作清单。 */
export function buildKimiPlanPrompt({ prompt, summary = '', mode = 'cowork', memory = '' }: PromptOptions): string {
  const userPrompt = cleanText(prompt);
  if (!userPrompt) {
    throw new Error('prompt is required');
  }
  if (userPrompt.length > MAX_PROMPT_LENGTH) {
    throw new Error(`prompt is too long; max ${MAX_PROMPT_LENGTH} characters`);
  }

  const safeSummary = cleanText(summary).slice(0, 2400);
  const memoryBlock = buildMemoryBlock(memory);
  const lines: string[] = [];
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

/** 拼装「对话模式」提示词:仅基于消息与摘要回答,需文件操作时提示切到协作模式。 */
export function buildKimiChatPrompt({ prompt, summary = '', memory = '' }: PromptOptions): string {
  const userPrompt = cleanText(prompt);
  if (!userPrompt) {
    throw new Error('prompt is required');
  }
  if (userPrompt.length > MAX_PROMPT_LENGTH) {
    throw new Error(`prompt is too long; max ${MAX_PROMPT_LENGTH} characters`);
  }

  const safeSummary = cleanText(summary).slice(0, 2400);
  const memoryBlock = buildMemoryBlock(memory);
  const lines: string[] = [];
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

/** 构造计划模式的 Kimi CLI 命令行参数(工作目录、单次输出、步数上限、提示词)。 */
export function buildKimiCliPlanArgs({
  trustedRoot,
  prompt,
  summary,
  mode,
  maxSteps = DEFAULT_MAX_STEPS,
  model,
  memory = '',
}: CliArgsOptions): string[] {
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

/** 构造对话模式的 Kimi CLI 命令行参数。 */
export function buildKimiCliChatArgs({
  trustedRoot,
  prompt,
  summary,
  maxSteps = DEFAULT_MAX_STEPS,
  model,
  memory = '',
}: CliArgsOptions): string[] {
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
