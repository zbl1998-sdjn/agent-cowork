// Tiny, dependency-free Markdown renderer. HTML is escaped FIRST, then a small
// set of inline/block transforms are applied, so the output is XSS-safe by
// construction (no raw user HTML survives). Covers the common chat cases:
// headings, bold/italic, inline + fenced code (with a language label, copy
// button, and light comment/string highlighting), links, and unordered lists.

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Escape a value destined for an HTML attribute (adds quote escaping on top of
// escapeHtml, so a URL can never break out of the href="" and inject onclick=…).
function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Allow only http/https links; anything else (javascript:, data:, file:, …) is
// rejected. `raw` has already been HTML-escaped by the caller.
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
  // Links: the URL char class excludes whitespace, ), quotes and angle brackets
  // so it cannot break out of the attribute; sanitizeUrl then enforces http/https.
  // Unsafe/non-matching links are left as their literal markdown text.
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)"'<>]+)\)/g, (_m: string, label: string, url: string) => {
    const safe = sanitizeUrl(url);
    if (!safe) return _m;
    return `<a href="${escapeAttr(safe)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });
  return out;
}

// Single-pass highlight of comments + strings (no nesting because each match is
// consumed once). Operates on already HTML-escaped text, so it never breaks the
// &amp;/&lt;/&gt; entities.
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
      const level = Math.min(heading[1].length + 2, 6);
      html += `<h${level}>${inline(heading[2])}</h${level}>`;
      continue;
    }
    const li = raw.match(/^\s*[-*]\s+(.*)$/);
    if (li) {
      if (!listOpen) { html += '<ul>'; listOpen = true; }
      html += `<li>${inline(li[1])}</li>`;
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

// Split assistant text into Markdown segments and inline-viz blocks. A fenced
// block ```chart / ```viz (JSON viz spec) or ```mermaid is pulled out so the UI
// can render it as a live chart inline in the conversation (show_widget feel).
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
    const lang = m[1];
    const inner = m[2].trim();
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
    else segments.push({ type: 'md', text: m[0] });
    last = re.lastIndex;
  }
  if (last < text.length) segments.push({ type: 'md', text: text.slice(last) });
  return segments.length ? segments : [{ type: 'md', text }];
}

// Pull an optional ```suggestions fenced block out of the assistant text and
// return the cleaned text plus the follow-up actions (one per line). The UI
// renders these as clickable chips — the Claude Cowork "suggested next steps".
export function extractSuggestions(src: string): { text: string; suggestions: string[] } {
  const text = String(src ?? '');
  const re = /```suggestions\n([\s\S]*?)```/;
  const m = re.exec(text);
  if (!m) return { text, suggestions: [] };
  const suggestions = m[1]
    .split('\n')
    .map((line) => line.replace(/^[-*\d.\s]+/, '').trim())
    .filter(Boolean)
    .slice(0, 4);
  const cleaned = `${text.slice(0, m.index)}${text.slice(m.index + m[0].length)}`.trim();
  return { text: cleaned, suggestions };
}
