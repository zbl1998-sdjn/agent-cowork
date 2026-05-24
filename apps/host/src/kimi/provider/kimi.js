export function createKimiProvider() {
  return {
    id: 'kimi',
    async chatCompletion({
      messages,
      tools,
      kimiConfig,
      fetchImpl = globalThis.fetch,
      onContent,
      onReasoning,
      signal,
    }) {
      if (!kimiConfig || !kimiConfig.apiKey) {
        throw new Error('Kimi API is not configured. Set KIMI_API_KEY.');
      }
      const endpoint = `${String(kimiConfig.baseUrl).replace(/\/+$/, '')}/chat/completions`;
      const headers = {
        authorization: `Bearer ${kimiConfig.apiKey}`,
        'content-type': 'application/json',
        accept: 'text/event-stream',
      };
      if (kimiConfig.userAgent) headers['user-agent'] = kimiConfig.userAgent;
      const body = {
        model: kimiConfig.model,
        messages,
        tools,
        tool_choice: 'auto',
        max_tokens: kimiConfig.maxTokens || 2048,
        stream: true,
      };
      if (Number.isFinite(kimiConfig.temperature)) body.temperature = kimiConfig.temperature;
      const resp = await fetchImpl(endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal });
      if (!resp.ok) {
        throw new Error(`Kimi API request failed with status ${resp.status}`);
      }
      const reader = resp.body && typeof resp.body.getReader === 'function' ? resp.body.getReader() : null;
      if (!reader) {
        const json = await resp.json();
        return (json.choices && json.choices[0] && json.choices[0].message) || { content: '' };
      }
      return parseOpenAiCompatibleStream(reader, { onContent, onReasoning });
    },
  };
}

export async function parseOpenAiCompatibleStream(reader, { onContent, onReasoning } = {}) {
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let reasoning = '';
  let usage = null;
  const toolCalls = [];
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
      if (data === '[DONE]') {
        buffer = '';
        break;
      }
      let json;
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }
      if (json && json.usage) usage = json.usage;
      const delta = json && json.choices && json.choices[0] ? (json.choices[0].delta || {}) : {};
      if (delta.reasoning_content) {
        reasoning += delta.reasoning_content;
        if (typeof onReasoning === 'function') onReasoning(delta.reasoning_content);
      }
      if (delta.content) {
        content += delta.content;
        if (typeof onContent === 'function') onContent(delta.content);
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index || 0;
          if (!toolCalls[idx]) {
            toolCalls[idx] = { id: tc.id || `call_${idx}`, type: 'function', function: { name: '', arguments: '' } };
          }
          if (tc.id) toolCalls[idx].id = tc.id;
          if (tc.function && tc.function.name) toolCalls[idx].function.name = tc.function.name;
          if (tc.function && tc.function.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
        }
      }
    }
  }
  const calls = toolCalls.filter(Boolean);
  return { content, reasoning_content: reasoning || undefined, tool_calls: calls.length ? calls : undefined, usage };
}
