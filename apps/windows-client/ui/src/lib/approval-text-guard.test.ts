import { describe, expect, it } from 'vitest';
import { neutralizeInvisibleDirectives } from './approval-text-guard';

// 用码点构造夹具与期望值,避免测试源码里出现原始不可见字符或被转义器改写。
const ch = (cp: number) => String.fromCharCode(cp);
const esc = (cp: number) => ch(0x5c) + 'u' + cp.toString(16).toUpperCase().padStart(4, '0');

describe('neutralizeInvisibleDirectives', () => {
  it('makes a right-to-left override visible instead of letting it reorder text', () => {
    const spoofed = 'del safe.txt' + ch(0x202e) + ' txt.evil';
    const result = neutralizeInvisibleDirectives(spoofed);
    expect(result).toBe('del safe.txt' + esc(0x202e) + ' txt.evil');
    expect(result.includes(ch(0x202e))).toBe(false);
  });

  it('makes bidi isolates and directional marks visible', () => {
    const input = ch(0x2066) + 'a' + ch(0x2069) + ch(0x200f) + 'b' + ch(0x061c);
    expect(neutralizeInvisibleDirectives(input)).toBe(
      esc(0x2066) + 'a' + esc(0x2069) + esc(0x200f) + 'b' + esc(0x061c),
    );
  });

  it('makes zero-width characters visible', () => {
    const zw = [0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0x00ad];
    const input = 'pass' + zw.map(ch).join('') + 'word';
    expect(neutralizeInvisibleDirectives(input)).toBe('pass' + zw.map(esc).join('') + 'word');
  });

  it('keeps ordinary Chinese text with visible punctuation unchanged', () => {
    const text = '把"登录报错"改成「已修复」,写入 C:/报告/周报.md';
    expect(neutralizeInvisibleDirectives(text)).toBe(text);
  });

  it('keeps plain ASCII, RTL letters, and empty input unchanged', () => {
    expect(neutralizeInvisibleDirectives('')).toBe('');
    expect(neutralizeInvisibleDirectives('const x = 1;')).toBe('const x = 1;');
    expect(neutralizeInvisibleDirectives('שלום عالم')).toBe('שלום عالم');
  });
});
