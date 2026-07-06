// Agent 上下文压缩配置解析(host · L3 路由层 · routes)
// ---------------------------------------------------------------------------
// 职责:把 /api/agent/chat/stream 请求体中的 UI 开关/预算字段解析成 tool-loop 的 contextOptions。
//       当请求未显式指定 maxContextTokens 时,按「当前所选模型」的上下文窗口自适应推导
//       压缩阈值(留输出余量),避免大窗口模型被写死的保守默认过早压缩。
import { omitUndefined } from '../util/object.js';
import { resolveHistoryBudgetTokens } from '../kimi/context/model-context-window.js';
import { findModelProviderCatalog } from '../kimi/provider/catalog.js';

type NumericLimit = number | string;

type ContextCompactionConfig = {
  enabled?: boolean;
  maxContextTokens?: NumericLimit;
  keepRecentMessages?: NumericLimit;
  maxFacts?: NumericLimit;
  contextWindowTokens?: NumericLimit;
};

type AgentContextRequestBody = {
  contextCompaction?: ContextCompactionConfig;
  autoCompactContext?: boolean;
  maxContextTokens?: NumericLimit;
  keepRecentMessages?: NumericLimit;
  maxContextFacts?: NumericLimit;
  contextWindowTokens?: NumericLimit;
};

export type AgentContextOptions = {
  maxContextTokens?: number;
  keepRecentMessages?: number;
  maxFacts?: number;
};

// 当前所选模型提示:用于在请求未显式指定 maxContextTokens 时,按模型窗口自适应推导预算。
export type AgentModelContextHint = {
  provider?: unknown;
  model?: unknown;
};

const DISABLED_MAX_CONTEXT_TOKENS = 1_000_000_000;

function objectOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function positiveInt(value: unknown, min: number, max: number): number | undefined {
  if (value == null || value === '') return undefined;
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return undefined;
  const rounded = Math.round(num);
  if (rounded < min) return min;
  if (rounded > max) return max;
  return rounded;
}

// 收敛行为的运行时开关:让部署可关闭/调整「工具纪律」与「步数收尾提醒」而不改代码。
export type AgentConvergenceOptions = { stepNudgeRatio?: number; toolDiscipline?: boolean };

export function resolveAgentConvergenceOptions(
  env: Record<string, string | undefined> = process.env,
): AgentConvergenceOptions {
  const out: AgentConvergenceOptions = {};
  const ratio = env.KCW_STEP_NUDGE_RATIO;
  if (ratio != null && ratio !== '' && Number.isFinite(Number(ratio))) out.stepNudgeRatio = Number(ratio);
  const discipline = String(env.KCW_TOOL_DISCIPLINE ?? '').trim().toLowerCase();
  if (discipline === '0' || discipline === 'false' || discipline === 'off') out.toolDiscipline = false;
  return out;
}

export function resolveAgentContextOptions(
  body: unknown,
  modelHint?: AgentModelContextHint,
): AgentContextOptions {
  const raw = objectOrEmpty(body) as AgentContextRequestBody;
  const nested = objectOrEmpty(raw.contextCompaction) as ContextCompactionConfig;
  const enabled = nested.enabled !== false && raw.autoCompactContext !== false;
  if (!enabled) return { maxContextTokens: DISABLED_MAX_CONTEXT_TOKENS };
  // 显式请求值优先;否则按模型窗口自适应;都没有则留空,交由 history-compactor 用其保守默认。
  const explicitMax = positiveInt(nested.maxContextTokens ?? raw.maxContextTokens, 256, 1_000_000);
  // 本地/BYO 网关(Ollama、LM Studio、自建 OpenAI 兼容端点)的真实 num_ctx 不可从模型名
  // 静态推断,按模型族猜大窗口会危险高估;这类 provider 跳过族猜测,只认显式声明的窗口。
  const localProvider = findModelProviderCatalog(modelHint?.provider)?.region === 'local';
  const explicitWindow = positiveInt(nested.contextWindowTokens ?? raw.contextWindowTokens, 256, 10_000_000);
  const derivedMax = explicitMax == null && modelHint
    ? resolveHistoryBudgetTokens(omitUndefined({
      provider: modelHint.provider,
      model: modelHint.model,
      contextWindowTokens: explicitWindow,
      skipFamilyWindow: localProvider,
    }))
    : undefined;
  return omitUndefined({
    maxContextTokens: explicitMax ?? derivedMax,
    keepRecentMessages: positiveInt(nested.keepRecentMessages ?? raw.keepRecentMessages, 1, 100),
    maxFacts: positiveInt(nested.maxFacts ?? raw.maxContextFacts, 1, 200),
  });
}
