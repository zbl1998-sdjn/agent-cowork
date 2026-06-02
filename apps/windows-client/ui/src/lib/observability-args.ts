// 可观测参数摘要(UI · 逻辑层 · lib)
// ---------------------------------------------------------------------------
// 职责:把工具调用的 args(字符串/对象/任意值)浓缩成一句带截断的可读摘要,
// 让可观测面板在事件无显式 reason 时也能显示「调用了什么」。导出:summariseArgs。
export function summariseArgs(args: unknown): string {
  if (args == null) return '';
  if (typeof args === 'string') return args.length > 140 ? `${args.slice(0, 138)}…` : args;
  if (typeof args !== 'object') return String(args);
  const entries = Object.entries(args as Record<string, unknown>).slice(0, 4);
  if (entries.length === 0) return '';
  const parts = entries.map(([key, value]) => {
    let valueText: string;
    if (typeof value === 'string') {
      valueText = value;
    } else if (typeof value === 'object' && value !== null) {
      try {
        valueText = JSON.stringify(value);
      } catch {
        valueText = '[object]';
      }
    } else {
      valueText = String(value);
    }
    if (valueText.length > 60) valueText = `${valueText.slice(0, 58)}…`;
    return `${key}=${valueText}`;
  });
  const joined = parts.join(', ');
  return joined.length > 140 ? `${joined.slice(0, 138)}…` : joined;
}
