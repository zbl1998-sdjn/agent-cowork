import type { MouseEvent } from 'react';
import { renderMarkdown, splitVizBlocks } from '../lib/md';
import { InlineViz } from './InlineViz';
import type { VizSpec } from '../lib/api';

// Delegate clicks on fenced-code "复制" buttons (rendered as raw HTML by
// renderMarkdown) to copy the adjacent code text.
function onCodeCopy(e: MouseEvent<HTMLDivElement>) {
  const btn = (e.target as HTMLElement).closest('.code-copy');
  if (!btn) return;
  const code = btn.closest('.code-block')?.querySelector('code');
  if (!code) return;
  try {
    void navigator.clipboard.writeText(code.textContent || '');
    const prev = btn.textContent;
    btn.textContent = '已复制';
    setTimeout(() => { btn.textContent = prev || '复制'; }, 1200);
  } catch { /* clipboard unavailable */ }
}

// Assistant message body: Markdown prose with any ```chart/```mermaid blocks
// rendered as live inline charts, and ```code blocks with copy + light highlight.
export function MessageText({ text, trustedRoot }: { text: string; trustedRoot?: string }) {
  const segments = splitVizBlocks(text);
  return (
    <div className="message-text markdown" onClick={onCodeCopy}>
      {segments.map((seg, i) => (seg.type === 'viz' && seg.spec
        ? <InlineViz key={i} spec={seg.spec as unknown as VizSpec} trustedRoot={trustedRoot} />
        : <div key={i} dangerouslySetInnerHTML={{ __html: renderMarkdown(seg.text || '') }} />))}
    </div>
  );
}
