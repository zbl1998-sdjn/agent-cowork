#!/usr/bin/env node
// Kimi 前缀缓存命中基线探针(apps/host/scripts · 安全只读度量)
// ---------------------------------------------------------------------------
// 职责:用真实 Kimi API 跑几条多步样例会话,量出「前缀缓存命中率」基线。镜像 bot 的
//   cache-baseline:把稳定前缀(真实 system 提示 + 代表性工具定义)在一个 session 内反复
//   复用(同 prompt_cache_key),逐次把返回的 usage.cached_tokens 喂进 cache-telemetry,
//   最后打印累计命中率 + 输入成本降幅 + 前缀稳定性诊断。
// 安全:只调 Kimi /chat/completions。**不执行任何工具、不读写文件、不连 MCP、不做任何
//   不可逆动作**;模型若返回 tool_calls 一律忽略(只取文本续聊)。工具定义仅放进请求让
//   前缀贴近真实。
// 配置:从环境变量取 key(KIMI_API_KEY 或 MOONSHOT_API_KEY;Node 22 自动读 .env)。
//   可选 KIMI_BASE_URL / KIMI_MODEL 覆盖。
// 用法:node scripts/run-host-node.mjs apps/host/scripts/cache-baseline.ts
import { createKimiProvider } from '../src/engine/provider/kimi.js';
import { resolveAgentModelConfig } from '../src/engine/api-runner-config.js';
import { buildSystemPrompt, buildEnvBlock } from '../src/engine/system-prompt.js';
import { resolveAgentEnvFacts } from '../src/engine/agent-env.js';
import {
  recordCacheUsage,
  getCacheTelemetry,
  resetCacheTelemetry,
  hashPrefix,
} from '../src/engine/cache-telemetry.js';

type ChatResult = { content?: unknown; usage?: unknown; tool_calls?: unknown };
type Msg = { role: string; content: unknown };

// Node 22:若存在 .env 则加载(无则忽略)。
try {
  (process as unknown as { loadEnvFile?: (p?: string) => void }).loadEnvFile?.('.env');
} catch {
  /* 无 .env,忽略 */
}

const cfg = resolveAgentModelConfig({}, process.env);
if (!cfg.configured || !cfg.apiKey) {
  console.error('[基线] 未配置 Kimi key。请在环境变量或 .env 设置 KIMI_API_KEY(或 MOONSHOT_API_KEY)后重试。');
  process.exit(2);
}

const kimiConfig: Record<string, unknown> = {
  apiKey: cfg.apiKey,
  baseUrl: cfg.baseUrl,
  model: cfg.model,
  maxTokens: 48, // 基线只测「输入」前缀命中,输出无关紧要 → 截短以加速、省 token

  ...(cfg.userAgent ? { userAgent: cfg.userAgent } : {}),
  ...(typeof cfg.temperature === 'number' ? { temperature: cfg.temperature } : {}),
};

// 真实生产 system 提示(前缀的大头);env facts 与 tool-loop 一致地解析。
const envFacts = resolveAgentEnvFacts({ trustedRoot: process.cwd(), kimiConfig });
// 与 agent 循环一致:系统前缀「不含日期」(跨天稳定),env 放进用户轮。
const systemPrompt = buildSystemPrompt({ env: envFacts, includeEnvBlock: false });
const envPreamble = buildEnvBlock(envFacts).join('\n');
const prefixHash = hashPrefix(systemPrompt);

// 代表性工具定义:放进请求让前缀更接近真实。真实循环工具更多/更大 → 真实命中只高不低,
// 故本基线偏保守。
const tools = [
  { type: 'function', function: { name: 'read_file', description: '读取工作区内的文件内容', parameters: { type: 'object', properties: { path: { type: 'string', description: '文件相对路径' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'write_file', description: '写入/创建工作区内的文件', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'list_dir', description: '列出目录下的文件', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'run_shell', description: '在沙箱中执行 shell 命令', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
  { type: 'function', function: { name: 'web_search', description: '联网检索', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'web_fetch', description: '抓取网页正文', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } } },
];

// 样例多步会话:每个 session 内的若干轮共享同一稳定前缀 + 同一 prompt_cache_key。
// 内容为良性对话,不需要真实执行工具(工具只为让前缀贴近真实)。
const sessions: Array<{ key: string; title: string; turns: string[] }> = [
  { key: 'baseline-sess-1', title: '概念问答', turns: [
    '简单说说什么是前缀缓存,为什么对 agent 省钱。',
    '它和普通的 KV cache 有什么区别?',
    '如果我的 system 提示里塞了时间戳,会怎样?',
    '总结一句:怎么把命中率做高。',
  ] },
  { key: 'baseline-sess-2', title: '任务规划', turns: [
    '帮我列一个"给老项目补单元测试"的步骤清单。',
    '第一步具体怎么做?',
    '如果测试很慢,有什么折中?',
  ] },
  { key: 'baseline-sess-3', title: '简答', turns: [
    '用一句话解释什么是幂等。',
    '再举个 HTTP 里的例子。',
    '那 POST 一定不幂等吗?',
  ] },
];

const provider = createKimiProvider();

async function callOnce(messages: Msg[], cacheKey: string): Promise<ChatResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    return (await provider.chatCompletion({
      messages,
      tools,
      kimiConfig,
      fetchImpl: globalThis.fetch,
      signal: controller.signal,
      promptCacheKey: cacheKey,
    })) as ChatResult;
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  resetCacheTelemetry();
  console.log(`[基线] 模型=${cfg.model} · baseUrl=${cfg.baseUrl} · 工具数=${tools.length} · 系统前缀≈${systemPrompt.length} 字`);
  console.log(`[基线] ${sessions.length} 个会话,前缀逐轮复用;第 1 轮多为冷启动(写缓存),之后应开始命中。不执行任何工具。`);

  for (const sess of sessions) {
    console.log(`\n──── 会话「${sess.title}」(key=${sess.key}) ────`);
    const messages: Msg[] = [{ role: 'system', content: systemPrompt }];
    let turn = 0;
    for (const q of sess.turns) {
      turn += 1;
      messages.push({ role: 'user', content: `${envPreamble}\n\n${q}` });
      let r: ChatResult;
      try {
        r = await callOnce(messages, sess.key);
      } catch (e) {
        console.log(`  轮 ${turn}: 调用失败(${String((e as { message?: unknown })?.message ?? e)}),跳过`);
        continue;
      }
      const m = recordCacheUsage(r.usage as Parameters<typeof recordCacheUsage>[0], { cacheKey: sess.key, prefixHash });
      console.log(`  轮 ${turn}: 命中 ${m.cached}/${m.prompt} 输入 tok(${m.rate}%)`);
      // 只取文本续聊;忽略任何 tool_calls(绝不执行)。
      messages.push({ role: 'assistant', content: (r.content && String(r.content)) || '(ok)' });
    }
  }

  const s = getCacheTelemetry();
  const costDrop = Math.round(0.8 * s.hitRatePct);
  console.log('\n══════════ Kimi 前缀缓存命中基线 ══════════');
  console.log(`调用次数=${s.calls} · 累计命中率=${s.hitRatePct}% · 命中 ${s.cachedTokens}/${s.promptTokens} 输入 tok`);
  console.log(`输入成本较无缓存≈↓${costDrop}%(Kimi 命中输入约 1/5–1/6 价 ⇒ 降幅≈0.8×命中率)`);
  console.log(`前缀稳定性:${s.prefixStable ? '稳定(1 种前缀)' : `⚠️ 不稳定(${s.distinctPrefixes} 种,疑似动态内容打穿)`}`);
  for (const k of s.byKey) {
    console.log(`  · ${k.key}: ${k.calls} 次 · 命中率 ${k.hitRatePct}%`);
  }
  console.log('\n解读:第 1 轮冷启动命中低;从第 2 轮起共享前缀(system+工具+历史)应开始命中并爬升。');
  console.log('若整体偏低:多半是单段前缀未过 Kimi 最小缓存阈值,或前缀被动态内容打穿(看上面的稳定性诊断)。');
}

main().then(() => process.exit(0)).catch((e) => { console.error('[基线失败]', e); process.exit(1); });
