// 提示词精炼策略(host · L1 领域层 · engine/prompt)
// ---------------------------------------------------------------------------
// 职责:纯启发式分析用户原始 prompt——归一化、识别意图、判断缺失要素
//       (动作/目标/期望产出),据此决定该精炼、该追问还是已足够明确。
// 依赖:仅标准库(无副作用、无 I/O)。
// 导出:normalizePrompt、detectPromptIntent、analyzePromptForRefine。

const VAGUE_ONLY_PATTERNS = [
  /^(帮我|请)?(看看|看一下|处理|处理一下|弄一下|搞一下|优化一下|改一下|整理一下)$/iu,
  /^(help me )?(check|handle|fix|improve|optimi[sz]e)( it)?$/iu,
];

const ACTION_PATTERNS = [
  /总结|生成|创建|写|改写|优化|修复|解释|分析|审查|检查|翻译|提取|整理|实现|测试|运行|对比|归纳|导出|保存|转换|处理|排查|定位|复现|调试|重构|部署|配置|安装|清理|梳理|搭建|接入|对接|监控|备份|恢复|渲染|打包|起草|润色|校对|下载|上传|读取|查看|查询|修改|更新|新增|添加|替换|拆分|合并|上线|发布|计算|统计|设计/iu,
  /\b(summarize|generate|create|write|rewrite|improve|optimi[sz]e|fix|explain|analy[sz]e|review|test|run|compare|extract|implement|handle|debug|refactor|deploy|configure|install|build|design|update|add|remove|delete|download|upload|migrate|render)\b/iu,
];

const TARGET_PATTERNS = [
  /[a-zA-Z]:[\\/][^\s]+/u,
  /(?:^|\s|@)(?:[\w.-]+[\\/])+[\w .-]+/u,
  /\b[\w.-]+\.(?:js|ts|tsx|jsx|json|md|txt|py|rs|go|java|cs|cpp|h|yml|yaml|toml|csv|xlsx|docx|pdf)\b/iu,
  /代码|文件|目录|仓库|项目|计划|报告|表格|数据|截图|日志|README|测试|页面|组件|接口|路由|登录|注册|报错|错误|异常|缺陷|功能|需求|服务|数据库|按钮|样式|表单|弹窗|菜单|配置|环境|脚本|命令|流程|逻辑|性能|内存|网络|权限|账号|账户|订单|用户|消息|通知|缓存|队列|任务|模块|函数|方法|变量|参数|字段|模型|版本|分支|提交|镜像|容器|端口|bug/iu,
];

const OUTPUT_PATTERNS = [
  /输出|返回|给我|列出|写成|格式|步骤|计划|表格|报告|摘要|清单|代码|补丁/iu,
  /\b(output|return|list|format|steps|plan|table|report|summary|checklist|patch)\b/iu,
];

// 「已足够明确」判定的最小篇幅:再短的输入即便要素齐全,也值得润色一遍。
const EXPLICIT_MIN_LENGTH = 80;

// 兜底:够长(≥此长度)即便没命中动作/对象词表,也视作带意图,交给改写器尝试——
// 避免词表盖不全(如「处理/登录/报错」等常见说法)就把正常需求误判成「太空泛」。
const MIN_INTENT_LENGTH = 10;

export type PromptIntent = 'create' | 'fix' | 'review' | 'summarize' | 'translate' | 'general' | 'unknown';
export type PromptMissing = 'goal' | 'action' | 'target' | 'desiredOutput';
export type PromptAnalyzeOptions = { maxLength?: number };
export type PromptPolicy = {
  normalized: string;
  intent: PromptIntent;
  missing: PromptMissing[];
  shouldRefine: boolean;
  needsClarification: boolean;
  explicit: boolean;
};

function textIncludes(patterns: RegExp[], text: string): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

/** 归一化原始输入:统一换行、压空白、裁到最大长度。 */
export function normalizePrompt(raw: unknown, { maxLength = 8000 }: PromptAnalyzeOptions = {}): string {
  return String(raw ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

/** 按关键词判定任务意图(修复/创建/审查/总结/翻译/通用)。 */
export function detectPromptIntent(text: string): PromptIntent {
  if (/修复|报错|失败|fix|error|fail/iu.test(text)) return 'fix';
  if (/实现|新增|创建|生成|导出|保存|转换|build|implement|create|generate|export|save|convert/iu.test(text)) return 'create';
  if (/审查|检查|分析|review|analy[sz]e|inspect/iu.test(text)) return 'review';
  if (/总结|整理|归纳|summari[sz]e|organize/iu.test(text)) return 'summarize';
  if (/翻译|translate/iu.test(text)) return 'translate';
  return 'general';
}

/** 综合分析 prompt,产出意图、缺失要素与「精炼/追问/已明确」决策。 */
export function analyzePromptForRefine(raw: unknown, options: PromptAnalyzeOptions = {}): PromptPolicy {
  const normalized = normalizePrompt(raw, options);
  const missing: PromptMissing[] = [];
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
  // 追问:仅在「纯空泛」或「动作和对象都认不出、且短到看不出意图」时——再改也是瞎编。
  // 够长(≥MIN_INTENT_LENGTH)即便没命中词表,也按「带意图」处理,交给改写器尝试。
  const hasEnoughLength = normalized.length >= MIN_INTENT_LENGTH;
  const needsClarification = vagueOnly || (!hasAction && !hasTarget && !hasEnoughLength);
  // 改写:意图认得出就改;explicit 不再否决它(是否已足够明确交给改写结果判断)。
  const shouldRefine = !needsClarification;
  // explicit 降级为「已足够明确」信号:动作+对象+产出齐全且篇幅足够,仅供无模型兜底参考。
  const explicit = hasAction && hasTarget && hasOutputHint && normalized.length >= EXPLICIT_MIN_LENGTH;
  return {
    normalized,
    intent: detectPromptIntent(normalized),
    missing: dedupedMissing,
    shouldRefine,
    needsClarification,
    explicit,
  };
}
