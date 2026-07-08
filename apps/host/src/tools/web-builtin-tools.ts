// Web 内置工具描述符(host · L1 领域层 · tools)
// ---------------------------------------------------------------------------
// 职责:把联网类内置工具(web.fetch / WebSearch)的名称、描述、风险等级、
// 入参 schema 与 handler 收敛到一处,供工具集装配方按统一描述符形态接入。
// 安全:每次调用前先过 L0 出站网关(decideEgressPolicy, kind='web_fetch')——
// air_gap/local_strict 下必须拦住这两个工具的真实出网,不能让机密档只挡住模型调用
// 却漏了 WebFetch/WebSearch(这两个此前完全没接出站策略检查,是比 model_inference
// 更基础的缺口:dogfood 系统性排查出站面时发现)。
// 依赖:L1 tools(web-fetch/web-search),L0 security/egress-gateway、util(object.omitUndefined)。
// 导出:createWebBuiltinTools。
// 实现:把当前日期(now)注入 WebSearch 描述,提示模型搜「最新/今天」时带上当前年份。

import { webFetch } from './web-fetch.js';
import { webSearch } from './web-search.js';
import { omitUndefined } from '../util/object.js';
import { decideEgressPolicy, egressPolicyError, recordEgressDecision } from '../security/egress-gateway.js';
import { contextRecord } from './builtin-tool-options.js';
import type { WebFetchLike } from './web-fetch.js';
import type { WebSearchFetchLike } from './web-search.js';

type BuiltinToolArgs = Record<string, unknown>;
type BuiltinTool = {
  name: string;
  description: string;
  source: string;
  risk?: string;
  mutating?: boolean;
  requiresApproval?: boolean;
  inputSchema?: Record<string, unknown>;
  handler(args?: BuiltinToolArgs, ctx?: unknown): unknown | Promise<unknown>;
};
type CreateWebBuiltinToolsOptions = {
  fetchImpl?: WebFetchLike | WebSearchFetchLike;
  now?: Date;
  resolveSecurityMode?: () => unknown;
};

/** 出站前置检查:deny 就抛错(由工具循环统一转成失败的 tool_result,不静默放行)。 */
function assertWebEgressAllowed(destination: unknown, ctx: unknown, resolveSecurityMode?: () => unknown): void {
  const trustedRoot = contextRecord(ctx).trustedRoot;
  const egress = decideEgressPolicy({
    kind: 'web_fetch',
    destination,
    securityMode: resolveSecurityMode?.(),
    trustedRoot,
  });
  if (trustedRoot) {
    try { recordEgressDecision(trustedRoot, egress); } catch { /* 审计失败不能掩盖/放行策略结果 */ }
  }
  if (egress.decision === 'deny') throw egressPolicyError(egress);
}

/** 组装联网工具描述符;当前日期注入只用于提示模型搜索「最新/今天」时带年份。 */
export function createWebBuiltinTools({ fetchImpl, now = new Date(), resolveSecurityMode }: CreateWebBuiltinToolsOptions = {}): BuiltinTool[] {
  const monthYear = `${now.getFullYear()} 年 ${now.getMonth() + 1} 月`;
  return [
    {
      name: 'web.fetch',
      description: '抓取一个 http(s) 网址, 返回状态码、content-type 和截断后的文本 (联网研究用)',
      source: 'builtin',
      risk: 'high',
      requiresApproval: true,
      inputSchema: {
        type: 'object',
        properties: { url: { type: 'string' }, maxBytes: { type: 'number' }, timeoutMs: { type: 'number' } },
        required: ['url'],
      },
      handler: async (args = {}, ctx) => {
        assertWebEgressAllowed(args.url, ctx, resolveSecurityMode);
        return webFetch(omitUndefined({
          url: args.url,
          timeoutMs: args.timeoutMs,
          maxBytes: args.maxBytes,
          allowInternal: args.allowInternal === true,
          fetchImpl: fetchImpl as WebFetchLike | undefined,
        }));
      },
    },
    {
      name: 'WebSearch',
      description: `联网搜索关键词 → 返回 5-8 条结果(每条含标题/URL/摘要)。当前是 ${monthYear},搜"最新/今天/最近"相关话题务必带当前年份(${now.getFullYear()})避免拉到 ${now.getFullYear() - 2} 年的旧结果。需要查最新信息(新闻、文档版本、价格、是否还活着)优先用 WebSearch;给定确切 URL 再用 web.fetch。`,
      source: 'builtin',
      risk: 'low',
      mutating: false,
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词,建议带年份' },
          maxResults: { type: 'number', description: '返回结果数, 默认 8,最大 20' },
          provider: { type: 'string', description: 'auto(默认,先 DDG 失败回退 Bing)/ddg/bing/tavily(需 API key)' },
        },
        required: ['query'],
      },
      handler: async (args = {}, ctx) => {
        assertWebEgressAllowed(`search:${String(args.query || '')}`, ctx, resolveSecurityMode);
        return webSearch(omitUndefined({
          query: args.query,
          maxResults: args.maxResults,
          provider: args.provider || 'auto',
          fetchImpl: fetchImpl as WebSearchFetchLike | undefined,
        }));
      },
    },
  ];
}
