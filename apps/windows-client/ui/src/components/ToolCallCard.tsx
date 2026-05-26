import { useState, type CSSProperties } from 'react';
import type { ToolCallItem } from '../lib/app-types';
import { Button } from './ui/Button';

export type ToolCall = ToolCallItem;

function fmt(v: unknown): string {
  if (v == null) return '';
  try { return typeof v === 'string' ? v : JSON.stringify(v, null, 2); } catch { return String(v); }
}

const ICON: Record<string, string> = { running: '⟳', succeeded: '✓', failed: '✕', rejected: '✕', blocked: '⊘' };
const LABEL: Record<string, string> = { running: '运行中', succeeded: '成功', failed: '失败', rejected: '已拒绝', blocked: '已阻止' };

const headStyle: CSSProperties = {
  width: '100%',
  justifyContent: 'flex-start',
  gap: 8,
  border: 'none',
  background: 'transparent',
  padding: '7px 10px',
  fontSize: 13,
  textAlign: 'left',
};

function formatDuration(ms?: number): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
}

function failureReason(call: ToolCall): string {
  if (call.error) return call.error;
  const result = call.result;
  if (result && typeof result === 'object' && 'error' in result) {
    return String((result as { error?: unknown }).error || '');
  }
  if (call.status === 'failed') return '工具执行失败';
  if (call.status === 'rejected') return '用户拒绝了该操作';
  if (call.status === 'blocked') return '操作被安全策略阻止';
  return '';
}

// Collapsible tool-call card: shows the tool name + status, expands to reveal the
// input args and a result preview — the Claude Cowork "what the agent did" view.
export function ToolCallCard({ call }: { call: ToolCall }) {
  const [open, setOpen] = useState(false);
  const duration = formatDuration(call.durationMs);
  const reason = failureReason(call);
  return (
    <div className={`toolcall toolcall-${call.status}`}>
      <Button variant="ghost" className="toolcall-head" onClick={() => setOpen((o) => !o)} style={headStyle}>
        <span className={`toolcall-icon icon-${call.status}`}>{ICON[call.status] || '•'}</span>
        <code>{call.name}</code>
        <span className={`toolcall-status status-${call.status}`}>{LABEL[call.status] || call.status}</span>
        {duration ? <span className="toolcall-duration">{duration}</span> : null}
        <span className="toolcall-toggle">{open ? '收起' : '详情'}</span>
      </Button>
      {reason ? <div className="toolcall-summary">失败原因：{reason}</div> : null}
      {open && (
        <div className="toolcall-body">
          {call.args != null && <><div className="toolcall-section-title">参数</div><pre className="toolcall-args">{fmt(call.args).slice(0, 2000)}</pre></>}
          {call.result != null && <><div className="toolcall-section-title">结果</div><pre className="toolcall-result">{fmt(call.result).slice(0, 4000)}</pre></>}
        </div>
      )}
    </div>
  );
}
