import { describe, it, expect } from 'vitest';
import { extractSuggestions, splitVizBlocks, renderMarkdown } from './md';

describe('extractSuggestions', () => {
  it('pulls a fenced suggestions block and strips it from the text', () => {
    const src = '好的，已完成。\n```suggestions\n- 继续整理\n再做个图表\n```';
    const { text, suggestions } = extractSuggestions(src);
    expect(suggestions).toEqual(['继续整理', '再做个图表']);
    expect(text).toBe('好的，已完成。');
    expect(text).not.toContain('suggestions');
  });
  it('returns the text unchanged when there is no block', () => {
    const { text, suggestions } = extractSuggestions('普通回答');
    expect(suggestions).toEqual([]);
    expect(text).toBe('普通回答');
  });
  it('caps at 4 suggestions', () => {
    const src = '```suggestions\na\nb\nc\nd\ne\nf\n```';
    expect(extractSuggestions(src).suggestions.length).toBe(4);
  });
});

describe('splitVizBlocks', () => {
  it('extracts a mermaid block as a viz segment', () => {
    const segs = splitVizBlocks('图：\n```mermaid\ngraph TD; A-->B\n```');
    expect(segs.some((s) => s.type === 'viz' && s.spec?.kind === 'mermaid')).toBe(true);
  });
  it('extracts a chart JSON block', () => {
    const segs = splitVizBlocks('```chart\n{"kind":"bar","data":{}}\n```');
    const viz = segs.find((s) => s.type === 'viz');
    expect(viz?.spec?.kind).toBe('bar');
  });
  it('plain text is a single md segment', () => {
    const segs = splitVizBlocks('没有图表');
    expect(segs).toHaveLength(1);
    expect(segs[0].type).toBe('md');
  });
  it('invalid chart JSON falls back to md (not a broken viz)', () => {
    const segs = splitVizBlocks('```chart\nnot json\n```');
    expect(segs.every((s) => s.type === 'md')).toBe(true);
  });
});

describe('renderMarkdown', () => {
  it('escapes HTML to prevent XSS', () => {
    expect(renderMarkdown('<img src=x onerror=alert(1)>')).not.toContain('<img');
  });
  it('renders headings and inline code', () => {
    const html = renderMarkdown('# 标题\n`code`');
    expect(html).toContain('<h');
    expect(html).toContain('<code>code</code>');
  });
});
