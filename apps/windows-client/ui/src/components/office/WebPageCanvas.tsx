// 真实网页组件画布(UI · 组件层 · components/office)
// ---------------------------------------------------------------------------
// 职责:向无同源权限的固定 sandbox 画布传入清洁 HTML；桥接选择、结构、修改命令和可撤销 HTML 快照。
import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  WebComponentNode,
  WebEditorCommand,
  WebElementSelection,
  WebSnapshotReason,
  WebViewport,
} from '../../lib/types/webEditor';

const VIEWPORT_LABELS: ReadonlyArray<Readonly<{ id: WebViewport; label: string; detail: string }>> = [
  { id: 'desktop', label: '桌面', detail: '1440' },
  { id: 'tablet', label: '平板', detail: '768' },
  { id: 'mobile', label: '手机', detail: '390' },
];

export function sanitizeImportedWebSource(source: string): string {
  return source
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script\b[^>]*\/?\s*>/gi, '')
    .replace(/<(iframe|object|embed)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(?:iframe|object|embed|base)\b[^>]*\/?\s*>/gi, '')
    .replace(/<meta\b[^>]*http-equiv\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)[^>]*>/gi, '')
    .replace(/<link\b(?=[^>]*\brel\s*=\s*(?:"import"|'import'|import\b))[^>]*>/gi, '')
    .replace(/\s+on[a-z0-9_:-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s+(?:nonce|data-agent-cowork-[a-z0-9_-]+)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s+(href|src|xlink:href|action|formaction)\s*=\s*(["'])\s*(?:javascript|vbscript|file):[\s\S]*?\2/gi, '')
    .replace(/\s+(href|src|xlink:href|action|formaction)\s*=\s*(?:javascript|vbscript|file):[^\s>]*/gi, '');
}

export function WebPageCanvas({
  source,
  command,
  onSelection,
  onTree,
  onSnapshot,
}: {
  source: string;
  command?: WebEditorCommand | null;
  onSelection: (selection: WebElementSelection | null) => void;
  onTree?: (nodes: WebComponentNode[]) => void;
  onSnapshot: (html: string, reason: WebSnapshotReason) => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [viewport, setViewport] = useState<WebViewport>('desktop');
  const sendSource = useCallback(() => frame.current?.contentWindow?.postMessage({
    type: 'agent-cowork:web-init',
    html: sanitizeImportedWebSource(source),
  }, '*'), [source]);
  useEffect(() => {
    const listener = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || !event.data || typeof event.data !== 'object') return;
      if (event.data.type === 'agent-cowork:web-ready') sendSource();
      if (event.data.type === 'agent-cowork:web-select') onSelection(event.data.selection as WebElementSelection | null);
      if (event.data.type === 'agent-cowork:web-tree' && Array.isArray(event.data.nodes)) onTree?.(event.data.nodes as WebComponentNode[]);
      if (event.data.type === 'agent-cowork:web-snapshot' && typeof event.data.html === 'string') {
        onSnapshot(event.data.html, event.data.reason === 'undo' ? 'undo' : 'mutation');
      }
    };
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }, [onSelection, onSnapshot, onTree, sendSource]);
  useEffect(sendSource, [sendSource]);
  useEffect(() => {
    if (command) frame.current?.contentWindow?.postMessage({ type: 'agent-cowork:web-command', command }, '*');
  }, [command]);
  return (
    <section className="web-canvas-stage" aria-label="响应式网页画布">
      <div className="web-viewport-switcher" aria-label="预览尺寸">
        {VIEWPORT_LABELS.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-pressed={viewport === item.id}
            className={viewport === item.id ? 'is-active' : ''}
            onClick={() => setViewport(item.id)}
          >
            <span>{item.label}</span><small>{item.detail}</small>
          </button>
        ))}
      </div>
      <div className={`web-viewport-frame is-${viewport}`}>
        <iframe ref={frame} className="office-web-frame" title="网页实时画布" sandbox="allow-scripts" src="/office-web-frame.html" onLoad={sendSource} />
      </div>
    </section>
  );
}
