import { useState } from 'react';

export interface ToolCall { name: string; args?: unknown; status: string; result?: unknown }

function fmt(v: unknown): string {
  if (v == null) return '';
  try { return typeof v === 'string' ? v : JSON.stringify(v, null, 2); } catch { return String(v); }
}

const ICON: Record<string, string> = { running: '⟳', succeeded: '✓', failed: '✕', rejected: '✕', blocked: '⊘' };

// Collapsible tool-call card: shows the tool name + status, expands to reveal the
// input args and a result preview — the Claude Cowork "what the agent did" view.
export function ToolCallCard({ call }: { call: ToolCall }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`toolcall toolcall-${call.status}`}>
      <button type="button" className="toolcall-head" onClick={() => setOpen((o) => !o)}>
        <span className={`toolcall-icon icon-${call.status}`}>{ICON[call.status] || '•'}</span>
        <code>{call.name}</code>
        <span className="toolcall-toggle">{open ? '收起' : '详情'}</span>
      </button>
      {open && (
        <div className="toolcall-body">
          {call.args != null && <pre className="toolcall-args">{fmt(call.args).slice(0, 2000)}</pre>}
          {call.result != null && <pre className="toolcall-result">{fmt(call.result).slice(0, 4000)}</pre>}
        </div>
      )}
    </div>
  );
}
