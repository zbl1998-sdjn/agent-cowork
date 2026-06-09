// Markdown 渲染(UI · lib)
// ---------------------------------------------------------------------------
// 职责:零依赖的轻量 Markdown 渲染器。先转义 HTML、再套用少量行内/块级变换,从源头保证 XSS 安全。
// 依赖:无。导出:Markdown→安全 HTML 渲染函数。
function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// 转义 HTML 属性值;在 escapeHtml 基础上额外转义引号,避免 URL 逃出 href 注入事件属性。
function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// 仅允许 http/https 链接;其它协议(javascript/data/file 等)直接拒绝。
function sanitizeUrl(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    return (u.protocol === 'http:' || u.protocol === 'https:') ? raw.trim() : null;
  } catch {
    return null;
  }
}

function inline(text: string): string {
  let out = text;
  out = out.replace(/`([^`]+)`/g, (_m, code) => `<code>${code}</code>`);
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  // 链接正则排除空白、右括号、引号与尖括号,再由 sanitizeUrl 限定 http/https。
  // 不安全或不匹配的链接保留为原始 Markdown 文本。
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)"'<>]+)\)/g, (_m: string, label: string, url: string) => {
    const safe = sanitizeUrl(url);
    if (!safe) return _m;
    return `<a href="${escapeAttr(safe)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });
  return out;
}

// 单遍高亮注释与字符串;输入已完成 HTML 转义,不会破坏 &amp;/&lt;/&gt; 实体。
function highlightCode(escaped: string): string {
  return escaped.replace(
    /(\/\*[\s\S]*?\*\/|\/\/[^\n]*|#[^\n]*|"[^"\n]*"|'[^'\n]*'|`[^`\n]*`)/g,
    (m) => {
      const isComment = m[0] === '/' || m[0] === '#';
      return `<span class="${isComment ? 'tok-c' : 'tok-s'}">${m}</span>`;
    },
  );
}

function codeBlockHtml(escapedCode: string, lang: string): string {
  const label = (lang || '').replace(/[^a-zA-Z0-9+#._-]/g, '').slice(0, 20) || 'code';
  return `<div class="code-block"><div class="code-head"><span class="code-lang">${label}</span>`
    + '<button class="code-copy" type="button">复制</button></div>'
    + `<pre><code>${highlightCode(escapedCode)}</code></pre></div>`;
}

export function renderMarkdown(src: string): string {
  const lines = escapeHtml(String(src ?? '')).split('\n');
  let html = '';
  let inCode = false;
  let codeBuf: string[] = [];
  let codeLang = '';
  let listOpen = false;
  const flushList = () => { if (listOpen) { html += '</ul>'; listOpen = false; } };

  for (const raw of lines) {
    if (raw.trim().startsWith('```')) {
      if (inCode) {
        html += codeBlockHtml(codeBuf.join('\n'), codeLang);
        codeBuf = [];
        codeLang = '';
        inCode = false;
      } else {
        flushList();
        inCode = true;
        codeLang = raw.trim().slice(3).trim();
      }
      continue;
    }
    if (inCode) { codeBuf.push(raw); continue; }

    const heading = raw.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushList();
      const marker = heading[1] || '';
      const body = heading[2] || '';
      const level = Math.min(marker.length + 2, 6);
      html += `<h${level}>${inline(body)}</h${level}>`;
      continue;
    }
    const li = raw.match(/^\s*[-*]\s+(.*)$/);
    if (li) {
      if (!listOpen) { html += '<ul>'; listOpen = true; }
      html += `<li>${inline(li[1] || '')}</li>`;
      continue;
    }
    if (raw.trim() === '') { flushList(); continue; }
    flushList();
    html += `<p>${inline(raw)}</p>`;
  }
  if (inCode) { html += codeBlockHtml(codeBuf.join('\n'), codeLang); }
  flushList();
  return html;
}

// 把助手文本拆成 Markdown 段与 inline-viz 段;chart/viz/mermaid 围栏会被前端内联渲染成图表。
export interface MdSegment {
  type: 'md' | 'viz';
  text?: string;
  spec?: { kind: string; [key: string]: unknown };
}

export function splitVizBlocks(src: string): MdSegment[] {
  const text = String(src ?? '');
  const re = /```(chart|viz|mermaid)\n([\s\S]*?)```/g;
  const segments: MdSegment[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) segments.push({ type: 'md', text: text.slice(last, m.index) });
    const lang = m[1] || '';
    const inner = (m[2] || '').trim();
    let spec: { kind: string; [key: string]: unknown } | null = null;
    if (lang === 'mermaid') {
      spec = { kind: 'mermaid', definition: inner };
    } else {
      try {
        const parsed = JSON.parse(inner);
        if (parsed && typeof parsed === 'object' && parsed.kind) spec = parsed as { kind: string };
      } catch { spec = null; }
    }
    if (spec && spec.kind) segments.push({ type: 'viz', spec });
    else segments.push({ type: 'md', text: m[0] || '' });
    last = re.lastIndex;
  }
  if (last < text.length) segments.push({ type: 'md', text: text.slice(last) });
  return segments.length ? segments : [{ type: 'md', text }];
}

// 抽取可选 suggestions 围栏,返回清理后的正文与逐行后续动作;UI 会渲染成可点击建议 chip。
export function extractSuggestions(src: string): { text: string; suggestions: string[] } {
  const text = String(src ?? '');
  const re = /```suggestions\n([\s\S]*?)```/;
  const m = re.exec(text);
  if (!m) return { text, suggestions: [] };
  const suggestions = (m[1] || '')
    .split('\n')
    .map((line) => line.replace(/^[-*\d.\s]+/, '').trim())
    .filter(Boolean)
    .slice(0, 4);
  const cleaned = `${text.slice(0, m.index)}${text.slice(m.index + m[0].length)}`.trim();
  return { text: cleaned, suggestions };
}
