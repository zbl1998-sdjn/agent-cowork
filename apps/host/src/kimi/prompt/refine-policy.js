const VAGUE_ONLY_PATTERNS = [
  /^(帮我|请)?(看看|看一下|处理|处理一下|弄一下|搞一下|优化一下|改一下|整理一下)$/iu,
  /^(help me )?(check|handle|fix|improve|optimi[sz]e)( it)?$/iu,
];

const ACTION_PATTERNS = [
  /总结|生成|创建|写|改写|优化|修复|解释|分析|审查|检查|翻译|提取|整理|实现|测试|运行|对比|归纳|导出|保存|转换/iu,
  /\b(summarize|generate|create|write|rewrite|improve|optimi[sz]e|fix|explain|analy[sz]e|review|test|run|compare|extract|implement)\b/iu,
];

const TARGET_PATTERNS = [
  /[a-zA-Z]:[\\/][^\s]+/u,
  /(?:^|\s|@)(?:[\w.-]+[\\/])+[\w .-]+/u,
  /\b[\w.-]+\.(?:js|ts|tsx|jsx|json|md|txt|py|rs|go|java|cs|cpp|h|yml|yaml|toml|csv|xlsx|docx|pdf)\b/iu,
  /代码|文件|目录|仓库|项目|计划|报告|表格|数据|截图|日志|README|测试|页面|组件|接口|路由/iu,
];

const OUTPUT_PATTERNS = [
  /输出|返回|给我|列出|写成|格式|步骤|计划|表格|报告|摘要|清单|代码|补丁/iu,
  /\b(output|return|list|format|steps|plan|table|report|summary|checklist|patch)\b/iu,
];

/**
 * @typedef {'create' | 'fix' | 'review' | 'summarize' | 'translate' | 'general' | 'unknown'} PromptIntent
 * @typedef {'goal' | 'action' | 'target' | 'desiredOutput'} PromptMissing
 * @typedef {{ maxLength?: number }} PromptAnalyzeOptions
 * @typedef {{ normalized: string, intent: PromptIntent, missing: PromptMissing[], shouldRefine: boolean, needsClarification: boolean, explicit: boolean }} PromptPolicy
 */

/** @param {RegExp[]} patterns @param {string} text @returns {boolean} */
function textIncludes(patterns, text) {
  return patterns.some((pattern) => pattern.test(text));
}

/** @param {unknown} raw @param {PromptAnalyzeOptions} [options] @returns {string} */
export function normalizePrompt(raw, { maxLength = 8000 } = {}) {
  return String(raw ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

/** @param {string} text @returns {PromptIntent} */
export function detectPromptIntent(text) {
  if (/修复|报错|失败|fix|error|fail/iu.test(text)) return 'fix';
  if (/实现|新增|创建|生成|导出|保存|转换|build|implement|create|generate|export|save|convert/iu.test(text)) return 'create';
  if (/审查|检查|分析|review|analy[sz]e|inspect/iu.test(text)) return 'review';
  if (/总结|整理|归纳|summari[sz]e|organize/iu.test(text)) return 'summarize';
  if (/翻译|translate/iu.test(text)) return 'translate';
  return 'general';
}

/** @param {unknown} raw @param {PromptAnalyzeOptions} [options] @returns {PromptPolicy} */
export function analyzePromptForRefine(raw, options = {}) {
  const normalized = normalizePrompt(raw, options);
  /** @type {PromptMissing[]} */
  const missing = [];
  if (!normalized) {
    return {
      normalized,
      intent: 'unknown',
      missing: ['goal'],
      shouldRefine: false,
      needsClarification: true,
      explicit: false,
    };
  }

  const vagueOnly = VAGUE_ONLY_PATTERNS.some((pattern) => pattern.test(normalized));
  const hasAction = !vagueOnly && textIncludes(ACTION_PATTERNS, normalized);
  const hasTarget = textIncludes(TARGET_PATTERNS, normalized) || normalized.length >= 28;
  const hasOutputHint = textIncludes(OUTPUT_PATTERNS, normalized);

  if (!hasAction) missing.push('action');
  if (!hasTarget) missing.push('target');
  if (vagueOnly || (!hasAction && !hasOutputHint)) missing.push('desiredOutput');

  const dedupedMissing = [...new Set(missing)];
  const explicit = dedupedMissing.length === 0 && normalized.length >= 18;
  return {
    normalized,
    intent: detectPromptIntent(normalized),
    missing: dedupedMissing,
    shouldRefine: dedupedMissing.length === 0 && !explicit,
    needsClarification: dedupedMissing.length > 0,
    explicit,
  };
}
