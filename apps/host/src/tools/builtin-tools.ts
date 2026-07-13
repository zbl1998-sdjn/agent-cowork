// 内置工具清单(host · L1 领域层)
// ---------------------------------------------------------------------------
// 职责:把 host 已有能力封装成「工具描述符 + handler」,供 ToolRegistry 登记。
//       本层只负责组装和注入依赖;具体工具输入继续由各领域实现做细粒度校验。

import { normalizeSandboxSpec } from '../sandbox/index.js';
import { runCode } from '../sandbox/code-runner.js';
import { runRecipe } from '../recipes/run-recipe.js';
import { listRecipes } from '../recipes/registry.js';
import { searchWorkspaceIndex } from '../workspace/index/search.js';
import { planFileOrganization } from '../workspace/file-organizer.js';
import { createWebBuiltinTools } from './web-builtin-tools.js';
import { createGitReadOnlyBuiltinTools } from './dev/git.js';
import { profileDataFile } from './data/profile.js';
import { analyzeDataFile } from './data/report.js';
import { createDataChartArtifact } from './data/artifact.js';
import { argsRecord, contextRecord, parseBuiltinToolArgs, parseBuiltinToolsOptions } from './builtin-tool-options.js';
import { builtinArtifactGuards } from './builtin-artifact-guards.js';
import { omitUndefined } from '../util/object.js';
import type { BuiltinToolsOptionsInput } from './builtin-tool-options.js';
import type { ToolEntry } from './tool-registry.js';

const DATA_FILE_ARGS = ['path', 'maxRows', 'maxBytes'] as const;
const DATA_CHART_ARGS = ['path', 'title', 'id', 'maxRows', 'maxBytes'] as const;
const ORGANIZE_ARGS = ['files', 'mode', 'targetDir', 'renamePrefix'] as const;

/** 按运行环境组装全部内置工具描述符。 */
export function createBuiltinTools(options: BuiltinToolsOptionsInput = {}): ToolEntry[] {
  const {
    sandbox,
    sandboxLimits = {},
    runStoreRoot,
    runEvents = null,
    runsIndex = null,
    enableWebTools = true,
    fetchImpl,
    resolveSecurityMode,
  } = parseBuiltinToolsOptions(options);
  const tools: ToolEntry[] = [];

  if (sandbox) {
    tools.push({
      name: 'sandbox.exec',
      description: '在沙箱里运行一个结构化命令 (tool + args), 默认无网络, cwd 限定 trusted root',
      source: 'builtin',
      risk: 'high',
      mutating: true,
      requiresApproval: true,
      handler: async (rawArgs, rawCtx) => {
        const args = argsRecord(rawArgs);
        const ctx = contextRecord(rawCtx);
        const spec = normalizeSandboxSpec(args.spec || args, sandboxLimits);
        return sandbox.exec(spec, omitUndefined({ trustedRoot: ctx.trustedRoot, context: ctx.context }));
      },
    });

    tools.push({
      name: 'sandbox.run-code',
      description: '在沙箱里运行一段内联代码 (node / python), 物化为脚本文件后执行并产出 run 记录',
      source: 'builtin',
      risk: 'high',
      mutating: true,
      requiresApproval: true,
      handler: async (rawArgs, rawCtx) => {
        const args = argsRecord(rawArgs);
        const ctx = contextRecord(rawCtx);
        return runCode(omitUndefined({
          sandbox,
          sandboxLimits,
          tool: args.tool,
          code: args.code,
          prompt: args.prompt,
          ext: args.ext,
          timeoutMs: args.timeoutMs,
          network: args.network === true,
          unrestrictedHostExecution: args.unrestrictedHostExecution === true,
          trustedRoot: ctx.trustedRoot || '',
          runStoreRoot: runStoreRoot || '',
          runEvents,
          runsIndex,
          context: ctx.context,
        }));
      },
    });
  }

  if (enableWebTools) {
    tools.push(...createWebBuiltinTools(omitUndefined({ fetchImpl, resolveSecurityMode })));
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
    handler: async (rawArgs, rawCtx) => {
      const args = argsRecord(rawArgs);
      const guard = builtinArtifactGuards(rawCtx);
      const { ctx } = guard;
      return searchWorkspaceIndex({
        root: ctx.trustedRoot,
        query: args.query,
        limit: args.limit,
        maxFiles: args.maxFiles,
        maxFileBytes: args.maxFileBytes,
        includeFile: guard.include,
      });
    },
  });

  tools.push(...createGitReadOnlyBuiltinTools());

  tools.push({
    name: 'data.profile',
    description: '只读：剖析工作区内 CSV/TSV/XLSX 数据文件，返回列类型、缺失值、数值统计和图表建议。',
    source: 'builtin',
    risk: 'low',
    mutating: false,
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, maxRows: { type: 'number' }, maxBytes: { type: 'number' } },
      required: ['path'],
      additionalProperties: false,
    },
    handler: async (rawArgs, rawCtx) => {
      const args = parseBuiltinToolArgs(rawArgs, DATA_FILE_ARGS);
      const guard = builtinArtifactGuards(rawCtx);
      guard.inspect(args.path);
      return profileDataFile(omitUndefined({ ...args, trustedRoot: guard.ctx.trustedRoot }));
    },
  });

  tools.push({
    name: 'data.analyze',
    description: '只读：分析工作区内 CSV/TSV/XLSX 数据文件，返回列统计、图表数据和 Markdown 报告草稿。',
    source: 'builtin',
    risk: 'low',
    mutating: false,
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, maxRows: { type: 'number' }, maxBytes: { type: 'number' } },
      required: ['path'],
      additionalProperties: false,
    },
    handler: async (rawArgs, rawCtx) => {
      const args = parseBuiltinToolArgs(rawArgs, DATA_FILE_ARGS);
      const guard = builtinArtifactGuards(rawCtx);
      guard.inspect(args.path);
      return analyzeDataFile(omitUndefined({ ...args, trustedRoot: guard.ctx.trustedRoot }));
    },
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
      additionalProperties: false,
    },
    handler: async (rawArgs, rawCtx) => {
      const args = parseBuiltinToolArgs(rawArgs, DATA_CHART_ARGS);
      const guard = builtinArtifactGuards(rawCtx);
      guard.inspect(args.path);
      return createDataChartArtifact(omitUndefined({
        ...args,
        trustedRoot: guard.ctx.trustedRoot,
        context: guard.ctx.context,
      }));
    },
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
      additionalProperties: false,
    },
    handler: async (rawArgs, rawCtx) => {
      const args = parseBuiltinToolArgs(rawArgs, ORGANIZE_ARGS);
      const guard = builtinArtifactGuards(rawCtx);
      guard.inspectFiles(args.files);
      return planFileOrganization(omitUndefined({ ...args, trustedRoot: guard.ctx.trustedRoot }));
    },
  });

  for (const recipe of listRecipes()) {
    tools.push({
      name: `recipe.${recipe.id}`,
      description: [recipe.name, recipe.description].filter(Boolean).join(' — '),
      source: 'recipe',
      risk: 'low',
      mutating: false,
      handler: async (rawArgs, rawCtx) => {
        const args = argsRecord(rawArgs);
        const guard = builtinArtifactGuards(rawCtx);
        const { ctx } = guard;
        guard.inspectFiles(args.files);
        return await runRecipe(omitUndefined({
          recipeId: recipe.id,
          trustedRoot: ctx.trustedRoot || '',
          prompt: args.prompt || '',
          files: Array.isArray(args.files) ? args.files : [],
          maxSize: args.maxSize,
          context: ctx.context,
          runStoreRoot: runStoreRoot || '',
          runEvents,
          runsIndex,
        }));
      },
    });
  }

  return tools;
}
