// Provider 层共享类型(host · L1 领域层 · kimi/provider)
// ---------------------------------------------------------------------------
// 职责:给 provider 注册表、适配器与调用方提供同层类型,不承载运行时代码。

export type Provider = {
  id: string;
  chatCompletion(args: ProviderChatArgs): unknown | Promise<unknown>;
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
};
