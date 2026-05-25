import { callModelResilient } from './model-resilience.js';

export function addUsage(totals, usage) {
  if (!usage) return;
  totals.prompt_tokens += Number(usage.prompt_tokens || 0);
  totals.completion_tokens += Number(usage.completion_tokens || 0);
  totals.total_tokens += Number(usage.total_tokens || 0);
}

export async function summarizeAfterBudget({
  finalText,
  signal,
  messages,
  modelCall,
  kimiConfig,
  fetchImpl,
  emit,
  usageTotals,
}) {
  if (finalText || (signal && signal.aborted)) return finalText;
  try {
    messages.push({
      role: 'user',
      content: '已达到本轮工具调用上限。请不要再调用任何工具，直接用简洁的中文总结你目前已完成的内容和得到的结果，并说明若还有未完成的步骤是什么。',
    });
    const wrap = await callModelResilient(modelCall, {
      messages,
      tools: [],
      kimiConfig,
      fetchImpl,
      onContent: (d) => { if (d) emit('token', { delta: d }); },
      onReasoning: () => {},
    }, {
      kimiConfig,
      timeoutMs: kimiConfig && kimiConfig.timeoutMs,
      onFallback: (event) => emit('model_fallback', event),
    });
    addUsage(usageTotals, wrap && wrap.usage);
    return (wrap && wrap.content) || '';
  } catch {
    return '';
  }
}

export function applyStaticBackstop(finalText, signal, emit) {
  if (finalText || (signal && signal.aborted)) return finalText;
  const text = '我执行了几步操作，但还没能在本轮内完成并给出结论。你可以让我"继续"，或把任务说得更具体一些。';
  emit('token', { delta: text });
  return text;
}

export function sse(response, event, data) {
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
