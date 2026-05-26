// @ts-check
import { callModelResilient } from './model-resilience.js';

/**
 * @typedef {{ prompt_tokens?: unknown, completion_tokens?: unknown, total_tokens?: unknown }} Usage
 * @typedef {{ prompt_tokens: number, completion_tokens: number, total_tokens: number }} UsageTotals
 * @typedef {{ role: string, content: unknown }} Message
 * @typedef {{ usage?: Usage, content?: string }} ModelResult
 * @typedef {(type: string, payload: Record<string, unknown>) => void} Emit
 * @typedef {{ finalText?: string, signal?: AbortSignal | null, messages: Message[], modelCall: import('./model-resilience.js').ModelCall, kimiConfig?: Record<string, unknown>, fetchImpl?: unknown, emit: Emit, usageTotals: UsageTotals }} SummarizeOptions
 */

/** @param {UsageTotals} totals @param {Usage | null | undefined} usage */
export function addUsage(totals, usage) {
  if (!usage) return;
  totals.prompt_tokens += Number(usage.prompt_tokens || 0);
  totals.completion_tokens += Number(usage.completion_tokens || 0);
  totals.total_tokens += Number(usage.total_tokens || 0);
}

/** @param {SummarizeOptions} options */
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
    /** @param {unknown} delta */
    const emitToken = (delta) => { if (delta) emit('token', { delta }); };
    const timeoutMs = typeof kimiConfig?.timeoutMs === 'number' ? kimiConfig.timeoutMs : undefined;
    messages.push({
      role: 'user',
      content: '已达到本轮工具调用上限。请不要再调用任何工具，直接用简洁的中文总结你目前已完成的内容和得到的结果，并说明若还有未完成的步骤是什么。',
    });
    const wrap = await callModelResilient(modelCall, {
      messages,
      tools: [],
      kimiConfig,
      fetchImpl,
      onContent: emitToken,
      onReasoning: () => {},
    }, {
      kimiConfig,
      timeoutMs,
      onFallback: (event) => emit('model_fallback', event),
    });
    const result = /** @type {ModelResult} */ (wrap || {});
    addUsage(usageTotals, result.usage);
    return result.content || '';
  } catch {
    return '';
  }
}

/** @param {string} finalText @param {AbortSignal | null | undefined} signal @param {Emit} emit */
export function applyStaticBackstop(finalText, signal, emit) {
  if (finalText || (signal && signal.aborted)) return finalText;
  const text = '我执行了几步操作，但还没能在本轮内完成并给出结论。你可以让我"继续"，或把任务说得更具体一些。';
  emit('token', { delta: text });
  return text;
}

/** @param {{ write(chunk?: string | Buffer): unknown }} response @param {string} event @param {unknown} data */
export function sse(response, event, data) {
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
