const DEFAULT_BASE_URL = 'https://api.moonshot.ai/v1';
const DEFAULT_MODEL = 'kimi-k2.6';
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_TOKENS = 2048;
const MAX_PROMPT_LENGTH = 8000;
export const KIMI_API_NOT_CONFIGURED_MESSAGE = '未配置 Kimi/Moonshot API Key。本地文件功能仍可离线使用；需要模型回复时请联网并配置 KIMI_API_KEY 或 MOONSHOT_API_KEY。';

function cleanText(value) {
  return String(value || '').replace(/\r\n/g, '\n').trim();
}

function buildMemoryBlock(memory) {
  const text = cleanText(memory).slice(0, 4096);
  if (!text) {
    return '';
  }
  return [
    '工作区记忆 (.AgentCowork/MEMORY.md, 用户已确认的长期事实, 严格遵守):',
    text,
    '工作区记忆结束。',
  ].join('\n');
}

export function buildKimiApiPlanPrompt({ prompt, summary = '', mode = 'cowork', memory = '' }) {
  const userPrompt = cleanText(prompt);
  if (!userPrompt) {
    throw new Error('prompt is required');
  }
  if (userPrompt.length > MAX_PROMPT_LENGTH) {
    throw new Error(`prompt is too long; max ${MAX_PROMPT_LENGTH} characters`);
  }

  const safeSummary = cleanText(summary).slice(0, 2400);
  const memoryBlock = buildMemoryBlock(memory);
  const lines = [];
  if (memoryBlock) {
    lines.push(memoryBlock);
  }
  lines.push(
    '只基于下面摘要回答，不要读取文件，不要使用工具，不要修改文件，不要运行命令。',
    '用中文 Markdown 输出：目标理解、三条整理建议、审批前本地动作清单。',
    `模式：${mode === 'code' ? 'code' : 'cowork'}`,
    `摘要：${safeSummary || '暂无。'}`,
    `用户指令：${userPrompt}`,
  );
  return lines.join('\n');
}

export function buildKimiApiChatPrompt({ prompt, summary = '', memory = '' }) {
  const userPrompt = cleanText(prompt);
  if (!userPrompt) {
    throw new Error('prompt is required');
  }
  if (userPrompt.length > MAX_PROMPT_LENGTH) {
    throw new Error(`prompt is too long; max ${MAX_PROMPT_LENGTH} characters`);
  }

  const safeSummary = cleanText(summary).slice(0, 2400);
  const memoryBlock = buildMemoryBlock(memory);
  const lines = [];
  if (memoryBlock) {
    lines.push(memoryBlock);
  }
  lines.push('你是 Agent Cowork 的智能助手，用简洁、自然的中文与用户对话，像同事一样直接回答问题，不要套话。');
  lines.push('日常聊天无需读写文件，也不要生成“执行计划/待审批操作”；只有当用户明确要整理或处理本地文件时，再提示可在左侧选择对应模板。');
  if (safeSummary) lines.push(`参考摘要：${safeSummary}`);
  lines.push(`用户：${userPrompt}`);
  return lines.join('\n');
}

export function resolveKimiApiConfig(config = {}, env = process.env) {
  const apiKey = String(config.kimiApiKey || env.KIMI_API_KEY || env.MOONSHOT_API_KEY || '').trim();
  const baseUrl = String(config.kimiBaseUrl || env.KIMI_BASE_URL || env.MOONSHOT_BASE_URL || DEFAULT_BASE_URL).trim();
  const model = String(config.kimiModel || env.KIMI_MODEL || DEFAULT_MODEL).trim();
  const timeoutMs = Math.max(1000, Number(config.kimiApiTimeoutMs || env.KIMI_API_TIMEOUT_MS || DEFAULT_TIMEOUT_MS));
  const maxTokens = Math.max(1, Number(config.kimiApiMaxTokens || env.KIMI_API_MAX_TOKENS || DEFAULT_MAX_TOKENS));
  const userAgent = String(config.kimiUserAgent || env.KIMI_USER_AGENT || '').trim();
  const tempRaw = config.kimiTemperature != null ? config.kimiTemperature : env.KIMI_TEMPERATURE;
  const temperature = tempRaw != null && tempRaw !== '' && Number.isFinite(Number(tempRaw)) ? Number(tempRaw) : undefined;
  return {
    provider: 'kimi-api',
    configured: Boolean(apiKey),
    apiKey,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    model,
    timeoutMs,
    maxTokens,
    temperature,
    userAgent,
  };
}

function extractMessageText(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === 'string') {
    return cleanText(content);
  }
  if (Array.isArray(content)) {
    return cleanText(
      content
        .map((part) => {
          if (typeof part === 'string') {
            return part;
          }
          if (part && typeof part.text === 'string') {
            return part.text;
          }
          return '';
        })
        .filter(Boolean)
        .join('\n'),
    );
  }
  return '';
}

async function runKimiApiText({
  prompt,
  summary,
  mode,
  memory = '',
  apiKey,
  baseUrl = DEFAULT_BASE_URL,
  model = DEFAULT_MODEL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxTokens = DEFAULT_MAX_TOKENS,
  fetchImpl = globalThis.fetch,
  userAgent,
  temperature,
  promptBuilder,
  resultMode,
} = {}) {
  if (!apiKey || typeof apiKey !== 'string') {
    throw new Error(KIMI_API_NOT_CONFIGURED_MESSAGE);
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch is not available for Kimi API calls');
  }

  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
  const endpoint = `${String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '')}/chat/completions`;
  const apiPrompt = promptBuilder({ prompt, summary, mode, memory });

  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
        ...(userAgent ? { 'user-agent': userAgent } : {}),
      },
      body: JSON.stringify({
        model: String(model || DEFAULT_MODEL),
        messages: [
          {
            role: 'user',
            content: apiPrompt,
          },
        ],
        ...(Number.isFinite(temperature) ? { temperature } : {}),
        max_tokens: Math.max(1, Number(maxTokens) || DEFAULT_MAX_TOKENS),
        stream: false,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Kimi API request failed with status ${response.status}`);
    }

    const payload = await response.json();
    const text = extractMessageText(payload);
    if (!text) {
      throw new Error('Kimi API returned empty output');
    }

    return {
      ok: true,
      provider: 'kimi-api',
      model: String(model || DEFAULT_MODEL),
      mode: resultMode || (mode === 'code' ? 'code' : 'cowork'),
      text,
      durationMs: Date.now() - startedAt,
      usage: payload.usage || null,
    };
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`Kimi API timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export function runKimiApiPlan(options = {}) {
  return runKimiApiText({
    ...options,
    promptBuilder: buildKimiApiPlanPrompt,
    resultMode: options.mode === 'code' ? 'code' : 'cowork',
  });
}

export function runKimiApiChat(options = {}) {
  return runKimiApiText({
    ...options,
    promptBuilder: buildKimiApiChatPrompt,
    resultMode: 'chat',
  });
}

// Streaming chat: same OpenAI-compatible request with stream:true, parsing the
// upstream SSE and invoking onToken(delta) per content chunk. Returns the full
// accumulated text. Used by POST /api/kimi/chat/stream.
export async function runKimiApiChatStream({
  prompt,
  summary = '',
  memory = '',
  apiKey,
  baseUrl = DEFAULT_BASE_URL,
  model = DEFAULT_MODEL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxTokens = DEFAULT_MAX_TOKENS,
  fetchImpl = globalThis.fetch,
  onToken,
  onReasoning,
  signal,
  userAgent,
  temperature,
} = {}) {
  if (!apiKey || typeof apiKey !== 'string') {
    throw new Error(KIMI_API_NOT_CONFIGURED_MESSAGE);
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch is not available for Kimi API calls');
  }
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
  const endpoint = `${String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '')}/chat/completions`;
  const apiPrompt = buildKimiApiChatPrompt({ prompt, summary, memory });
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  let text = '';
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        accept: 'text/event-stream',
        ...(userAgent ? { 'user-agent': userAgent } : {}),
      },
      body: JSON.stringify({
        model: String(model || DEFAULT_MODEL),
        messages: [{ role: 'user', content: apiPrompt }],
        ...(Number.isFinite(temperature) ? { temperature } : {}),
        max_tokens: Math.max(1, Number(maxTokens) || DEFAULT_MAX_TOKENS),
        stream: true,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Kimi API request failed with status ${response.status}`);
    }
    const reader = response.body && typeof response.body.getReader === 'function' ? response.body.getReader() : null;
    if (!reader) {
      throw new Error('streaming not supported by this fetch implementation');
    }
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line || !line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') { buffer = ''; break; }
        try {
          const json = JSON.parse(data);
          const choiceDelta = json && json.choices && json.choices[0] ? (json.choices[0].delta || {}) : {};
          const reasoning = choiceDelta.reasoning_content || '';
          if (reasoning && typeof onReasoning === 'function') onReasoning(reasoning);
          const delta = choiceDelta.content || '';
          if (delta) {
            text += delta;
            if (typeof onToken === 'function') onToken(delta);
          }
        } catch {
          // ignore partial / non-JSON keepalive lines
        }
      }
    }
    return { ok: true, provider: 'kimi-api', model: String(model || DEFAULT_MODEL), mode: 'chat', text, durationMs: Date.now() - startedAt };
  } catch (error) {
    if (error && error.name === 'AbortError') {
      throw new Error(`Kimi API timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
