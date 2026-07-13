// 模型上下文窗口 → 历史压缩预算(host · L1 领域层 · engine/context)
// ---------------------------------------------------------------------------
// 职责:把「当前所选模型」映射到一个保守的上下文窗口 token 数,再据此推导历史压缩
//       的输入预算(留出输出与估算误差的余量)。让自动压缩阈值随模型能力自适应,
//       而不是所有 14+ provider 都卡在同一个写死的默认值上。
// 依赖:无内部依赖(纯数据 + 纯函数),可离线使用——压缩是安全机制,不应依赖网络
//       取值(air_gap/offline-local 模式下也必须工作)。
// 导出:resolveModelContextWindowTokens / deriveHistoryBudgetTokens /
//       resolveHistoryBudgetTokens 及默认常量。
//
// 数值口径(重要):这里的窗口是「按厂商/模型族的保守下限」,不是逐版本精确值。
//   刻意低估——真实溢出模型窗口是硬失败,提前一点压缩只是轻微低效。目录里的具体
//   版本号(如 kimi-k2.7 / claude-sonnet-5 / gemini-3.5)多为当前知识截止之后的
//   未来版本,精确窗口无法离线核实;后续可用 models.dev 的 limit.context 做精化。

export const DEFAULT_INPUT_RATIO = 0.75;
const MIN_INPUT_RATIO = 0.1;
const MAX_INPUT_RATIO = 1;
const MIN_BUDGET_TOKENS = 2_000;
// 上限护栏:任何声明/推断出的窗口都收敛到此上限内,避免一个笔误的巨大
// KCW_MODEL_CONTEXT_WINDOW(如 999999999)推导出荒谬预算、让压缩形同虚设。
export const MAX_CONTEXT_WINDOW_TOKENS = 2_000_000;

// 模型族优先(最具体):同一 provider 可能路由到窗口差异极大的模型(如 openrouter、
// 本地 openai-compatible 网关),按模型名里的族关键字判定更可靠。
const MODEL_FAMILY_WINDOWS: ReadonlyArray<{ match: RegExp; tokens: number }> = [
  { match: /(?:^|[/_-])claude/i, tokens: 200_000 },
  { match: /(?:^|[/_-])gemini/i, tokens: 1_000_000 },
  { match: /(?:^|[/_-])(?:gpt|chatgpt|o[1-9])/i, tokens: 128_000 },
  { match: /(?:^|[/_-])(?:kimi|moonshot)/i, tokens: 128_000 },
  { match: /(?:^|[/_-])deepseek/i, tokens: 65_536 },
  { match: /(?:^|[/_-])qwen/i, tokens: 131_072 },
  { match: /(?:^|[/_-])glm/i, tokens: 131_072 },
  { match: /minimax/i, tokens: 192_000 },
  { match: /(?:^|[/_-])grok/i, tokens: 131_072 },
  { match: /(?:^|[/_-])llama/i, tokens: 131_072 },
  { match: /(?:^|[/_-])(?:mistral|magistral|ministral|codestral)/i, tokens: 131_072 },
  { match: /(?:^|[/_-])sonar/i, tokens: 127_000 },
];

// provider id 兜底(catalog 里的规范化 provider 名)。openrouter 有意省略:它路由到
// 众多模型,只能按模型族判定。
const PROVIDER_WINDOWS: Readonly<Record<string, number>> = {
  'kimi-api': 128_000,
  deepseek: 65_536,
  'qwen-dashscope-cn': 131_072,
  'zai-glm': 131_072,
  minimax: 192_000,
  'siliconflow-cn': 65_536,
  openai: 128_000,
  anthropic: 200_000,
  google: 1_000_000,
  xai: 131_072,
  groq: 131_072,
  mistral: 131_072,
  perplexity: 127_000,
};

function cleanId(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

function positiveInteger(value: unknown): number | undefined {
  if (value == null || value === '') return undefined;
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return undefined;
  return Math.floor(num);
}

export type ModelWindowInput = { provider?: unknown; model?: unknown };

/**
 * 解析「当前模型」的保守上下文窗口 token 数:先按模型族关键字(含 provider/model 合并串),
 * 再按 provider id 兜底;都命中不了返回 undefined(交由调用方回落到既有默认)。
 */
export function resolveModelContextWindowTokens({ provider, model }: ModelWindowInput): number | undefined {
  const providerId = cleanId(provider);
  const modelId = cleanId(model);
  const haystack = providerId && modelId ? `${providerId}/${modelId}` : modelId || providerId;
  if (haystack) {
    for (const rule of MODEL_FAMILY_WINDOWS) {
      if (rule.match.test(haystack)) return rule.tokens;
    }
  }
  if (providerId && Object.prototype.hasOwnProperty.call(PROVIDER_WINDOWS, providerId)) {
    return PROVIDER_WINDOWS[providerId];
  }
  return undefined;
}

function clampRatio(ratio: unknown): number {
  const num = Number(ratio);
  if (!Number.isFinite(num) || num <= 0) return DEFAULT_INPUT_RATIO;
  return Math.min(MAX_INPUT_RATIO, Math.max(MIN_INPUT_RATIO, num));
}

/**
 * 由上下文窗口推导历史输入预算:window * ratio,留出输出与 token 估算误差的余量;
 * 结果落在 [MIN_BUDGET_TOKENS, window](window 有效时)内,始终为正。
 */
export function deriveHistoryBudgetTokens(
  contextWindow: number,
  { inputRatio }: { inputRatio?: number } = {},
): number {
  const raw = Number.isFinite(contextWindow) && contextWindow > 0 ? Math.floor(contextWindow) : 0;
  const window = Math.min(MAX_CONTEXT_WINDOW_TOKENS, raw);
  const ratio = clampRatio(inputRatio);
  const budget = Math.floor(window * ratio);
  const upper = window > 0 ? window : Number.MAX_SAFE_INTEGER;
  return Math.min(upper, Math.max(MIN_BUDGET_TOKENS, budget));
}

export type HistoryBudgetInput = ModelWindowInput & {
  // 显式声明的上下文窗口 token 数(最高优先级)。本地/BYO 网关(Ollama、LM Studio、
  // 自建 OpenAI 兼容端点)的真实 num_ctx 无法从模型名静态推断,必须靠这个显式声明;
  // 未传时回落环境变量 KCW_MODEL_CONTEXT_WINDOW。
  contextWindowTokens?: number;
  inputRatio?: number;
  // 跳过「按模型族/厂商猜窗口」。本地区域 provider 应置 true:同一本地网关可服务任意
  // 模型、任意 num_ctx,按模型名猜出的大窗口会危险高估(→ 溢出);无显式声明时宁可
  // 回落保守默认,也不乐观高估。
  skipFamilyWindow?: boolean;
};

/**
 * 一步到位:返回推导出的历史压缩预算,解析优先级:
 *   1) 显式窗口(contextWindowTokens 或环境变量 KCW_MODEL_CONTEXT_WINDOW);
 *   2) 非本地 provider 时按模型族/厂商静态窗口(skipFamilyWindow=false);
 *   3) 都没有 → undefined,让调用方保留既有保守默认(未知/本地模型行为不变、不高估)。
 * inputRatio 未显式传入时读环境变量 KCW_CONTEXT_INPUT_RATIO,再回落默认 0.75。
 */
export function resolveHistoryBudgetTokens(
  { provider, model, contextWindowTokens, inputRatio, skipFamilyWindow }: HistoryBudgetInput,
  env: Record<string, string | undefined> = process.env,
): number | undefined {
  const explicitWindow = positiveInteger(contextWindowTokens) ?? positiveInteger(env.KCW_MODEL_CONTEXT_WINDOW);
  const window = explicitWindow
    ?? (skipFamilyWindow ? undefined : resolveModelContextWindowTokens({ provider, model }));
  if (window == null) return undefined;
  const ratio = inputRatio ?? (env.KCW_CONTEXT_INPUT_RATIO != null ? Number(env.KCW_CONTEXT_INPUT_RATIO) : undefined);
  return deriveHistoryBudgetTokens(window, ratio == null ? {} : { inputRatio: ratio });
}
