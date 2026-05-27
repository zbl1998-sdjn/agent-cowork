import { normalizeSandboxSpec } from '../sandbox/index.js';
import { runCode } from '../sandbox/code-runner.js';
import { runRecipe } from '../recipes/run-recipe.js';
import { listRecipes } from '../recipes/registry.js';
import { searchWorkspaceIndex } from '../workspace/index/search.js';
import { planFileOrganization } from '../workspace/file-organizer.js';
import { webFetch } from './web-fetch.js';
import { createGitReadOnlyBuiltinTools } from './dev/git.js';
import { profileDataFile } from './data/profile.js';
import { analyzeDataFile } from './data/report.js';
import { createDataChartArtifact } from './data/artifact.js';

// Built-in tools wired to the host's existing capabilities. These are plain
// descriptors with handlers; the registry stays decoupled from the concrete
// sandbox / recipe / web machinery, and tests can register fakes instead.
//
// Each handler receives (args, ctx) where ctx = { trustedRoot, context }.
// @ts-check

/**
 * @typedef {{ trustedRoot?: string, context?: unknown }} ToolContext
 * @typedef {{ name: string, description: string, source: string, risk?: string, mutating?: boolean, requiresApproval?: boolean, inputSchema?: Record<string, any>, handler(args?: Record<string, any>, ctx?: ToolContext): unknown | Promise<unknown> }} BuiltinTool
 * @typedef {{ sandbox?: any, sandboxLimits?: Record<string, any>, runStoreRoot?: string, runEvents?: any, runsIndex?: any, enableWebTools?: boolean, fetchImpl?: any }} BuiltinToolsOptions
 */

/** @param {BuiltinToolsOptions} [options] @returns {BuiltinTool[]} */
export function createBuiltinTools({
  sandbox,
  sandboxLimits = {},
  runStoreRoot,
  runEvents = null,
  runsIndex = null,
  enableWebTools = true,
  fetchImpl,
} = {}) {
  /** @type {BuiltinTool[]} */
  const tools = [];

  if (sandbox) {
    tools.push({
      name: 'sandbox.exec',
      description: '在沙箱里运行一个结构化命令 (tool + args), 默认无网络, cwd 限定 trusted root',
      source: 'builtin',
      risk: 'high',
      mutating: true,
      requiresApproval: true,
      handler: async (args, ctx = {}) => {
        const spec = normalizeSandboxSpec(args?.spec || args, sandboxLimits);
        return sandbox.exec(spec, { trustedRoot: ctx.trustedRoot, context: ctx.context });
      },
    });

    tools.push({
      name: 'sandbox.run-code',
      description: '在沙箱里运行一段内联代码 (node / python), 物化为脚本文件后执行并产出 run 记录',
      source: 'builtin',
      risk: 'high',
      mutating: true,
      requiresApproval: true,
      handler: async (args = {}, ctx = {}) =>
        runCode({
          sandbox: /** @type {any} */ (sandbox),
          sandboxLimits,
          tool: args.tool,
          code: args.code,
          prompt: args.prompt,
          ext: args.ext,
          timeoutMs: args.timeoutMs,
          network: args.network === true,
          trustedRoot: ctx.trustedRoot || '',
          runStoreRoot: runStoreRoot || '',
          runEvents,
          runsIndex,
          context: /** @type {Record<string, unknown> | undefined} */ (ctx.context),
        }),
    });
  }

  if (enableWebTools) {
    tools.push({
      name: 'web.fetch',
      description: '抓取一个 http(s) 网址, 返回状态码、content-type 和截断后的文本 (联网研究用)',
      source: 'builtin',
      risk: 'high',
      requiresApproval: true,
      inputSchema: { type: 'object', properties: { url: { type: 'string' }, maxBytes: { type: 'number' }, timeoutMs: { type: 'number' } }, required: ['url'] },
      handler: async (args = {}) =>
        webFetch({ url: args.url, timeoutMs: args.timeoutMs, maxBytes: args.maxBytes, allowInternal: args.allowInternal === true, fetchImpl: /** @type {any} */ (fetchImpl) }),
    });
  }

  tools.push({
    name: 'SearchWorkspace',
    description: '在当前 trusted workspace 内做本地关键词/RAG 检索，返回相关文本块和来源行号。',
    source: 'builtin',
    risk: 'low',
    mutating: false,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number' },
        maxFiles: { type: 'number' },
        maxFileBytes: { type: 'number' },
      },
      required: ['query'],
    },
    handler: async (args = {}, ctx = {}) =>
      searchWorkspaceIndex({
        root: ctx.trustedRoot,
        query: args.query,
        limit: args.limit,
        maxFiles: args.maxFiles,
        maxFileBytes: args.maxFileBytes,
      }),
  });

  tools.push(.../** @type {BuiltinTool[]} */ (/** @type {unknown} */ (createGitReadOnlyBuiltinTools())));

  tools.push({
    name: 'data.profile',
    description: '只读：剖析工作区内 CSV/TSV/XLSX 数据文件，返回列类型、缺失值、数值统计和图表建议。',
    source: 'builtin',
    risk: 'low',
    mutating: false,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        maxRows: { type: 'number' },
        maxBytes: { type: 'number' },
      },
      required: ['path'],
    },
    handler: async (args = {}, ctx = {}) => profileDataFile({ trustedRoot: ctx.trustedRoot, ...args }),
  });

  tools.push({
    name: 'data.analyze',
    description: '只读：分析工作区内 CSV/TSV/XLSX 数据文件，返回列统计、图表数据和 Markdown 报告草稿。',
    source: 'builtin',
    risk: 'low',
    mutating: false,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        maxRows: { type: 'number' },
        maxBytes: { type: 'number' },
      },
      required: ['path'],
    },
    handler: async (args = {}, ctx = {}) => analyzeDataFile({ trustedRoot: ctx.trustedRoot, ...args }),
  });

  tools.push({
    name: 'data.createChartArtifact',
    description: '写入：分析工作区内 CSV/TSV/XLSX 数据文件，并把推荐图表保存为 .AgentCowork/artifacts 活页 artifact。',
    source: 'builtin',
    risk: 'high',
    mutating: true,
    requiresApproval: true,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        title: { type: 'string' },
        id: { type: 'string' },
        maxRows: { type: 'number' },
        maxBytes: { type: 'number' },
      },
      required: ['path'],
    },
    handler: async (args = {}, ctx = {}) => createDataChartArtifact({ trustedRoot: ctx.trustedRoot, ...args }),
  });

  tools.push({
    name: 'file.plan-organize',
    description: '只读：为批量整理/改名/去重生成文件操作预览，实际执行仍需走审批 apply。',
    source: 'builtin',
    risk: 'low',
    mutating: false,
    inputSchema: {
      type: 'object',
      properties: {
        files: { type: 'array', items: { type: 'string' } },
        mode: { type: 'string', enum: ['byExtension', 'rename', 'dedupe'] },
        targetDir: { type: 'string' },
        renamePrefix: { type: 'string' },
      },
      required: ['files'],
    },
    handler: async (args = {}, ctx = {}) => planFileOrganization({ trustedRoot: ctx.trustedRoot, ...args }),
  });

  for (const recipe of listRecipes()) {
    tools.push({
      name: `recipe.${recipe.id}`,
      description: [recipe.name, recipe.description].filter(Boolean).join(' — '),
      source: 'recipe',
      risk: 'low',
      mutating: false,
      handler: async (args = {}, ctx = {}) =>
        runRecipe({
          recipeId: recipe.id,
          trustedRoot: ctx.trustedRoot || '',
          prompt: args.prompt || '',
          files: args.files || [],
          maxSize: args.maxSize,
          context: /** @type {Record<string, unknown> | undefined} */ (ctx.context),
          runStoreRoot: runStoreRoot || '',
          runEvents,
          runsIndex,
        }),
    });
  }

  return tools;
}
