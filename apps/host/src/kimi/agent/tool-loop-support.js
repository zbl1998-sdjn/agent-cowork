// @ts-check

/**
 * @typedef {{ name: string, description?: string, parameters?: unknown, risk?: string, mutating?: boolean, handler?: Function }} AgentTool
 * @typedef {{ function?: { name?: string, arguments?: string } }} ToolCall
 */

/**
 * @param {AgentTool[]} agentTools
 * @param {AgentTool[]} lazyTools
 * @returns {Map<string, AgentTool>}
 */
export function addLazySearchTool(agentTools, lazyTools) {
  const activeNames = new Set(agentTools.map((t) => t.name));
  const toolMap = new Map(agentTools.map((t) => [t.name, t]));
  if (!Array.isArray(lazyTools) || !lazyTools.length) return toolMap;
  const searchTool = {
    name: 'search_tools',
    risk: 'safe',
    mutating: false,
    description: '按关键词检索可用的扩展工具(如外部连接器/MCP)。返回匹配工具的名称与描述;被检索到的工具随后即可直接调用。',
    parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] },
    handler: async ({ query = '', limit = 5 } = {}) => {
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

/** @param {ToolCall} call */
export function parseToolCall(call) {
  const name = call.function && call.function.name;
  try {
    return { name, args: JSON.parse((call.function && call.function.arguments) || '{}') };
  } catch {
    return { name, args: {} };
  }
}

export function createNoopBudgetGuard() {
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
