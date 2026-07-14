// 金标准端到端:真实 HTTP /api/agent/chat/stream + 真实 Ollama(openai/local)+ 短上下文窗口
// ---------------------------------------------------------------------------
// 目标:把「自适应压缩阈值」链路的最后一跳(HTTP 处理器 → 解析器 → 压缩器 → 真实模型)
//       也用真跑观测钉死。配置一个短窗口(KCW_MODEL_CONTEXT_WINDOW),发一段超过该
//       窗口预算的历史,断言真实 SSE 流里出现 context_compacted,且请求经真实 Ollama
//       生成回复后以 done 收尾。
//
// 可移植:测试启动前探测本机 Ollama;不可达(如 CI)时 t.skip(),不破坏门禁。
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from '../src/server.js';
import { noopKimiChatRunner, postAgentStream, readAgentStream } from './helpers/agent-stream.js';
import { bind, close, tempRoot } from './helpers/host-http.js';

const OLLAMA_BASE = process.env.KCW_OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
const OLLAMA_MODEL = process.env.KCW_OLLAMA_E2E_MODEL || 'qwen2.5:0.5b';
// 刻意短的窗口:证明压缩会在模型对应的短门槛上触发(而非写死的 12k)。budget=8192*0.75=6144。
const SHORT_WINDOW = 8192;

async function ollamaAvailable(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    const res = await fetch(`${OLLAMA_BASE}/api/tags`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return false;
    const data = await res.json() as { models?: Array<{ name?: string }> };
    return Array.isArray(data.models) && data.models.some((m) => m.name === OLLAMA_MODEL);
  } catch {
    return false;
  }
}

// 一段远超短窗口预算(6144 token)的用户输入 → 触发历史压缩。
function bigPrompt(): string {
  const filler = '这是可忽略的上下文填充内容。'.repeat(3000);
  return `请只回复四个字:压缩完成。\n\n背景资料(可忽略):${filler}`;
}

test('金标准 E2E: 真实 HTTP + 真实 Ollama + 短窗口 → SSE 出现 context_compacted 且 done 收尾', async (t) => {
  if (!(await ollamaAvailable())) {
    t.skip(`Ollama not reachable at ${OLLAMA_BASE} with model ${OLLAMA_MODEL}; skipping real-model E2E`);
    return;
  }

  const root = tempRoot('kcw-ctxwin-ollama-');
  const previousWindow = process.env.KCW_MODEL_CONTEXT_WINDOW;
  process.env.KCW_MODEL_CONTEXT_WINDOW = String(SHORT_WINDOW);

  // 不注入 agentModelCall → 走默认模型调用 → 真实打到 Ollama 的 openai 兼容端点。
  const server = createServer({
    requireAuth: false,
    trustedRoot: root,
    enableScheduler: false,
    modelProvider: 'openai/local',
    modelBaseUrl: `${OLLAMA_BASE}/v1`,
    model: OLLAMA_MODEL,
    modelChatRunner: noopKimiChatRunner,
  });
  const base = await bind(server);
  try {
    const res = await postAgentStream(base, { prompt: bigPrompt(), maxSteps: 2, autoApprove: true });
    assert.equal(res.status, 200);
    const stream = await readAgentStream(res);

    // 1) 压缩确实在短窗口门槛上触发(真实 SSE 事件,不是单测桩)。
    assert.match(stream, /event: context_compacted/, 'short window must trigger history compaction in the real stream');
    // 2) 请求经真实 Ollama 生成回复后正常收尾。
    assert.match(stream, /event: done/, 'the run must complete via the real Ollama model');
  } finally {
    await close(server);
    if (previousWindow === undefined) delete process.env.KCW_MODEL_CONTEXT_WINDOW;
    else process.env.KCW_MODEL_CONTEXT_WINDOW = previousWindow;
  }
});
