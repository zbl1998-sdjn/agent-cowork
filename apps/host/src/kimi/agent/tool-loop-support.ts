// 工具循环的零散支撑件(host · L1 领域层 · kimi/agent)
// ---------------------------------------------------------------------------
// 职责:为工具循环提供三件小工具——按需激活的 search_tools(懒加载扩展工具/MCP)、
//      解析模型返回的工具调用(JSON 参数容错)、以及无预算限制时的空预算守卫占位。
// 依赖:仅标准库。
// 导出:addLazySearchTool / parseToolCall / createNoopBudgetGuard
export type ToolArgs = Record<string, unknown>;
export type AgentTool = {
  name: string;
  description?: string;
  parameters?: unknown;
  risk?: string;
  mutating?: boolean;
  handler?: (args?: ToolArgs, context?: Record<string, unknown>) => unknown | Promise<unknown>;
};
export type ToolCall = { function?: { name?: string; arguments?: string } };
export type ParsedToolCall = { name: string | undefined; args: ToolArgs };
export type BudgetSnapshot = {
  runUsage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  sessionUsage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  runCostUsd: number;
  sessionCostUsd: number;
  elapsedMs: number;
  model: string;
};
export type BudgetCheckResult = {
  shouldAbort: boolean;
  limit: string;
  actual: number;
  maximum: number;
  reason: string;
  snapshot: BudgetSnapshot;
};
export type BudgetGuard = {
  check(): BudgetCheckResult;
  recordUsage(): BudgetCheckResult;
  stopMessage(): string;
};

/**
 * 注入 search_tools 工具:模型按关键词检索懒加载工具,命中后将其追加进活动工具集并即可调用。
 */
export function addLazySearchTool(agentTools: AgentTool[], lazyTools: AgentTool[]): Map<string, AgentTool> {
  const activeNames = new Set(agentTools.map((t) => t.name));
  const toolMap = new Map(agentTools.map((t) => [t.name, t]));
  if (!Array.isArray(lazyTools) || !lazyTools.length) return toolMap;
  const searchTool = {
    name: 'search_tools',
    risk: 'safe',
    mutating: false,
    description: '按关键词检索可用的扩展工具(如外部连接器/MCP)。返回匹配工具的名称与描述;被检索到的工具随后即可直接调用。',
    parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] },
    handler: async ({ query = '', limit = 5 }: ToolArgs = {}) => {
      const terms = String(query).toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/).filter(Boolean);
      const ranked = lazyTools
        .filter((t) => !activeNames.has(t.name))
        .map((t) => {
          const hay = `${t.name} ${t.description || ''}`.toLowerCase();
          return { t, score: terms.reduce((n, term) => n + (hay.includes(term) ? 1 : 0), 0) };
        })
        .filter((r) => terms.length === 0 || r.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, Math.max(1, Math.min(Number(limit) || 5, 20)));
      for (const { t } of ranked) {
        agentTools.push(t);
        toolMap.set(t.name, t);
        activeNames.add(t.name);
      }
      return { activated: ranked.map(({ t }) => ({ name: t.name, description: t.description || '' })) };
    },
  };
  agentTools.push(searchTool);
  toolMap.set(searchTool.name, searchTool);
  return toolMap;
}

/** 解析模型返回的工具调用,JSON 参数解析失败时降级为空参数 {}。 */
export function parseToolCall(call: ToolCall): ParsedToolCall {
  const name = call.function && call.function.name;
  try {
    return { name, args: JSON.parse((call.function && call.function.arguments) || '{}') };
  } catch {
    return { name, args: {} };
  }
}

/** 创建空预算守卫:check/recordUsage 永不叫停,作为未配置预算时的默认占位。 */
export function createNoopBudgetGuard(): BudgetGuard {
  const snapshot = {
    runUsage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    sessionUsage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    runCostUsd: 0,
    sessionCostUsd: 0,
    elapsedMs: 0,
    model: 'default',
  };
  const ok = { shouldAbort: false, limit: '', actual: 0, maximum: 0, reason: '', snapshot };
  return {
    check: () => ok,
    recordUsage: () => ok,
    stopMessage: () => '本轮已触发预算保护，已安全停止继续执行。',
  };
}
