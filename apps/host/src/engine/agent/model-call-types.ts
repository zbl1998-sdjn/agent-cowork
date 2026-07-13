// 模型调用公共类型(host · L1 领域层 · engine/agent)
// ---------------------------------------------------------------------------
// 职责:为韧性层与不可伪造 capability 提供无环依赖的最小调用契约。
export type ModelConfig = Record<string, unknown> & {
  apiKey?: unknown;
  fallbacks?: unknown;
  provider?: unknown;
  baseUrl?: unknown;
  model?: unknown;
};

export type ModelCallArgs = Record<string, unknown> & { signal?: AbortSignal };

export type ModelCall = (
  args: ModelCallArgs & { modelConfig: ModelConfig; signal: AbortSignal },
) => unknown | Promise<unknown>;
