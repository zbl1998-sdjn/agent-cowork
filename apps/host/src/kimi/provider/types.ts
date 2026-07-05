// Provider 层共享类型(host · L1 领域层 · kimi/provider)
// ---------------------------------------------------------------------------
// 职责:给 provider 注册表、适配器与调用方提供同层类型,不承载运行时代码。

export type ProviderToolCall = {
  id?: string | undefined;
  type?: string | undefined;
  function: {
    name: string;
    arguments: string;
  };
};

export type ProviderUsage = {
  prompt_tokens?: number | undefined;
  completion_tokens?: number | undefined;
  total_tokens?: number | undefined;
  input_tokens?: number | undefined;
  output_tokens?: number | undefined;
  cached_tokens?: number | undefined;
  prompt_cache_hit_tokens?: number | undefined;
} & Record<string, number | string | boolean | null | undefined>;

export type ProviderChatResult = {
  content: string;
  reasoning_content?: string | undefined;
  tool_calls?: ProviderToolCall[] | undefined;
  partial_tool_calls?: ProviderToolCall[] | undefined;
  usage?: ProviderUsage | null | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  finish_reason?: string | undefined;
  stream_interrupted?: boolean | undefined;
  stream_error?: string | undefined;
};

export type Provider = {
  id: string;
  chatCompletion(args: ProviderChatArgs): ProviderChatResult | Promise<ProviderChatResult>;
};

export type ModelConfig = Record<string, unknown> & {
  provider?: unknown;
  chatCompletion?: Provider['chatCompletion'];
};

export type ProviderChatArgs = {
  messages?: unknown[];
  tools?: unknown[];
  kimiConfig?: ModelConfig;
  fetchImpl?: unknown;
  onContent?: (delta: string) => void;
  onReasoning?: (delta: string) => void;
  signal?: AbortSignal;
  // 稳定缓存键(通常为 session/task id):官方建议多轮 agent 传入以提高前缀缓存命中率。
  promptCacheKey?: string;
};