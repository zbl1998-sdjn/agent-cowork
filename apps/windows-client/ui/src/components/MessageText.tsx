// MessageText 消息正文(UI · 组件层 · components)
// ---------------------------------------------------------------------------
// 职责:把消息文本经 lib/md 安全渲染为 Markdown,拆出 chart/mermaid 块交 InlineViz 内联渲染,并代理代码块"复制"按钮点击。
// 依赖:lib/md(renderMarkdown/splitVizBlocks)+ InlineViz + lib/api(VizSpec)。关键 props:text、trustedRoot。
import type { MouseEvent } from 'react';
import { renderMarkdown, splitVizBlocks } from '../lib/md';
import { InlineViz } from './InlineViz';
import type { VizSpec } from '../lib/api';

// 代理 fenced-code 里由 renderMarkdown 渲出的"复制"按钮点击,复制相邻代码文本。
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
  } catch { /* 剪贴板不可用时静默降级 */ }
}

export function MessageText({ text, trustedRoot }: { text: string; trustedRoot?: string | undefined }) {
  const segments = splitVizBlocks(text);
  return (
    <div className="message-text markdown" onClick={onCodeCopy}>
      {segments.map((seg, i) => (seg.type === 'viz' && seg.spec
        ? <InlineViz key={i} spec={seg.spec as unknown as VizSpec} trustedRoot={trustedRoot} />
        : <div key={i} dangerouslySetInnerHTML={{ __html: renderMarkdown(seg.text || '') }} />))}
    </div>
  );
}
