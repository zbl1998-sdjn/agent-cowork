// @ts-check
// Builds the agent's system prompt: capability framing + plan-mode rules +
// skills/memory injection + inline-viz/suggestions hints. Pure (no I/O), so it
// is trivially unit-testable and kept out of the agent loop module.

export const SYSTEM_PROMPT_VERSION = 'agent-system-prompt-v2';

const WEEKDAYS_ZH = ['日', '一', '二', '三', '四', '五', '六'];
const MONTHS_ZH = ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月'];

/**
 * @typedef {{ id: string, name: string, description?: string }} SkillDescriptor
 * @typedef {{ now?: Date, trustedRoot?: string, osName?: string, appVersion?: string, provider?: string, model?: string }} EnvFacts
 */

/**
 * Render the env block that pins the model to real-world facts: today's date,
 * working directory, OS, app version, current model. Without this block the
 * model answers "what year is it?" from its training cutoff (Kimi K2: ~2024-end).
 * Designed to live at the very TOP of the system prompt so it survives any
 * context-window compaction.
 *
 * @param {EnvFacts} facts
 * @returns {string[]} lines (caller joins with '\n')
 */
export function buildEnvBlock({ now = new Date(), trustedRoot = '', osName = '', appVersion = '', provider = '', model = '' } = {}) {
  const yyyy = now.getFullYear();
  const m = now.getMonth() + 1;
  const d = now.getDate();
  const weekday = WEEKDAYS_ZH[now.getDay()];
  const monthLong = MONTHS_ZH[now.getMonth()];
  const dateLine = `今天:${yyyy}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}(星期${weekday},${yyyy} 年 ${monthLong})`;
  const lines = ['<env>', dateLine];
  if (trustedRoot) lines.push(`工作目录:${trustedRoot}`);
  if (osName) lines.push(`操作系统:${osName}`);
  if (appVersion) lines.push(`应用版本:Agent Cowork v${appVersion}`);
  if (provider || model) lines.push(`当前模型:${[provider, model].filter(Boolean).join(' / ')}`);
  lines.push('</env>');
  lines.push('上面 <env> 块给出的是真实世界的当前时间和环境,凡是涉及"今天/最近/现在"的问题都以此为准,不要凭训练截止时间猜测。');
  return lines;
}

/**
 * @param {{ memoryText?: string, skills?: SkillDescriptor[], planMode?: boolean, developerMode?: boolean, env?: EnvFacts }} [options]
 * @returns {string}
 */
export function buildSystemPrompt({ memoryText = '', skills = [], planMode = false, developerMode = false, env } = {}) {
  const lines = [
    ...buildEnvBlock(env || {}),
    '',
    '你是 Agent Cowork，一个运行在用户本地电脑上的 AI 助手。',
    '你可以调用提供的工具来读写工作区文件、运行命令、抓取网页、调用已连接的外部连接器(MCP)，真正完成用户的任务，而不只是给建议。',
    '文件工具：Read 读文件、Glob 找文件、Grep 搜内容、Write 写文件、Edit 精确替换；需要跑命令用 Shell；需要联网用 WebFetch；外部能力用 mcp__ 开头的工具。所有文件操作限定在工作区内。',
    '开发工具：GitStatus/GitDiff/GitLog 是只读 git 工具；GitCommit 会创建提交，属于高风险变更，必须等待用户审批，不能静默提交。',
    // Windows-awareness + balanced tool guidance. Steer file *inspection* to the
    // native Read/Glob/Grep (faster, no approval) and away from broken Linux
    // shell commands — but DON'T discourage Shell overall: for tasks that need to
    // run commands/scripts/builds/git, the model should proactively use Shell
    // (it really executes on the box now), using Windows/PowerShell-compatible
    // commands. Earlier over-restriction made the model refuse to run commands
    // unless explicitly told to.
    '【运行环境】你在 Windows 上运行；要执行命令时用 Windows/PowerShell 能识别的写法(如 Get-ChildItem、dir、type、git、npm、node、python，而不是 ls/find/cat/head 这类 Linux 命令)。',
    '【主动动手完成任务】该用工具就直接用，不要只给建议、也不要等用户点名让你用某个工具：读文件/找文件/搜内容用 Read/Glob/Grep；要运行命令、跑脚本、构建、git 操作、查系统信息、处理数据等，就主动用 Shell(它在本机真实执行，会请用户逐条确认)；联网用 WebFetch；外部能力用 mcp__ 工具。',
    '【两点分寸】① 只有"查看/搜索文件"这种场景优先用 Read/Glob/Grep，而不是用 Shell 跑 ls/cat/grep——前者更快且无需批准；凡是真要执行命令/脚本/程序的任务，该用 Shell 就大胆用，别畏手畏脚。② 别用 `**/*` 暴力遍历很大的目录(先用更精确的 Glob 或限定子目录/扩展名)，也别为同一件事反复换不同工具来回试探。',
    '完成后用简洁、自然的中文总结你做了什么。不要编造文件内容，先读再改。',
    '需要展示数据时可在回答里直接输出围栏代码块：' + "```" + 'chart 接 JSON 图表规格(kind 为 bar/line/pie/doughnut/table，含 data)，或 ' + "```" + 'mermaid 接 Mermaid 定义；它们会在对话中内联渲染成图表。',
  ];
  if (planMode) {
    lines.push(
      '',
      '【计划模式】你现在处于计划模式，必须先规划、再执行：',
      '1) 只用只读工具(Read/Glob/Grep/WebFetch)研究清楚现状；',
      '2) 然后调用 ExitPlanMode 工具，提交一份简洁的中文计划草案，说明你打算做什么、会改动/新建哪些文件、分几步；',
      '3) 在用户批准计划之前，禁止调用任何写入或副作用工具(Write/Edit/Shell/mcp__ 外部连接器)；',
      '4) 用户批准后，按计划执行；若用户要求继续完善，则根据反馈修订后重新调用 ExitPlanMode。',
    );
  }
  if (developerMode) {
    lines.push(
      '',
      '【开发者模式】处理代码仓库、多文件编辑、测试和 git 任务时，遵守这些约束：',
      '1) 动手前先用简短计划说明目标、预计改动文件和验证命令；',
      '2) 先检查当前文件与 dirty tree，保留他人已有改动，不 revert 未经用户明确要求的改动；',
      '3) 优先做窄改，修改前读现有模式，跨文件变更要保持接口兼容；',
      '4) 改完先跑聚焦验证，再视风险跑更宽的检查；如验证因权限、EPERM、缺依赖或沙箱限制失败，要如实记录；',
      '5) git status/diff/log 用只读 git 工具；commit 必须先展示意图并等审批，不能静默提交。',
    );
  }
  if (Array.isArray(skills) && skills.length) {
    lines.push('', '可用 skills（用户已启用，按需参考其适用场景，可用 Skill 工具运行）：');
    for (const sk of skills.slice(0, 20)) lines.push(`- ${sk.name}（${sk.id}）：${sk.description || ''}`);
  }
  if (memoryText && memoryText.trim()) {
    lines.push('', '工作区记忆（分层，越靠后优先级越高，请严格遵守）：', memoryText.trim());
  }
  lines.push('回答结束时，可用 ' + "```" + 'suggestions 围栏块列出 2-3 个用户可能想做的后续动作(每行一句简短中文)，会渲染成可一键点击的建议。');
  lines.push('当用户要求"每天/每周/每月/到某个时间"自动做某事时，调用 ScheduleTask 工具创建定时任务(cron 5 段，或 fireAt 一次性 ISO 时间)，并把要做的事写进 prompt。');
  return lines.join('\n');
}
