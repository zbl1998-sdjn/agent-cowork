// Pure helper: turn a tool-call `args` blob into a short human-friendly
// summary so the Observability panel shows WHAT was invoked when the event
// doesn't carry an explicit `reason` field.

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
