import { normalizeSandboxSpec } from '../sandbox/index.js';
import { runCode } from '../sandbox/code-runner.js';
import { runRecipe } from '../recipes/run-recipe.js';
import { listRecipes } from '../recipes/registry.js';
import { webFetch } from './web-fetch.js';

// Built-in tools wired to the host's existing capabilities. These are plain
// descriptors with handlers; the registry stays decoupled from the concrete
// sandbox / recipe / web machinery, and tests can register fakes instead.
//
// Each handler receives (args, ctx) where ctx = { trustedRoot, context }.

export function createBuiltinTools({
  sandbox,
  sandboxLimits = {},
  runStoreRoot,
  runEvents = null,
  runsIndex = null,
  enableWebTools = true,
  fetchImpl,
} = {}) {
  const tools = [];

  if (sandbox) {
    tools.push({
      name: 'sandbox.exec',
      description: '在沙箱里运行一个结构化命令 (tool + args), 默认无网络, cwd 限定 trusted root',
      source: 'builtin',
      handler: async (args, ctx = {}) => {
        const spec = normalizeSandboxSpec(args?.spec || args, sandboxLimits);
        return sandbox.exec(spec, { trustedRoot: ctx.trustedRoot, context: ctx.context });
      },
    });

    tools.push({
      name: 'sandbox.run-code',
      description: '在沙箱里运行一段内联代码 (node / python), 物化为脚本文件后执行并产出 run 记录',
      source: 'builtin',
      handler: async (args = {}, ctx = {}) =>
        runCode({
          sandbox,
          sandboxLimits,
          tool: args.tool,
          code: args.code,
          prompt: args.prompt,
          ext: args.ext,
          timeoutMs: args.timeoutMs,
          network: args.network === true,
          trustedRoot: ctx.trustedRoot,
          runStoreRoot,
          runEvents,
          runsIndex,
          context: ctx.context,
        }),
    });
  }

  if (enableWebTools) {
    tools.push({
      name: 'web.fetch',
      description: '抓取一个 http(s) 网址, 返回状态码、content-type 和截断后的文本 (联网研究用)',
      source: 'builtin',
      inputSchema: { type: 'object', properties: { url: { type: 'string' }, maxBytes: { type: 'number' }, timeoutMs: { type: 'number' } }, required: ['url'] },
      handler: async (args = {}) =>
        webFetch({ url: args.url, timeoutMs: args.timeoutMs, maxBytes: args.maxBytes, allowInternal: args.allowInternal === true, fetchImpl }),
    });
  }

  for (const recipe of listRecipes()) {
    tools.push({
      name: `recipe.${recipe.id}`,
      description: [recipe.name, recipe.description].filter(Boolean).join(' — '),
      source: 'recipe',
      handler: async (args = {}, ctx = {}) =>
        runRecipe({
          recipeId: recipe.id,
          trustedRoot: ctx.trustedRoot,
          prompt: args.prompt || '',
          files: args.files || [],
          maxSize: args.maxSize,
          context: ctx.context,
          runStoreRoot,
          runEvents,
          runsIndex,
        }),
    });
  }

  return tools;
}
