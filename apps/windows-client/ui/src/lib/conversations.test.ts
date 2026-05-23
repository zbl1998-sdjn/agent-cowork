import { describe, it, expect } from 'vitest';
import { convTitle, conversationToMarkdown, isImagePath } from './conversations';

describe('isImagePath', () => {
  it('matches image extensions case-insensitively', () => {
    expect(isImagePath('a.png')).toBe(true);
    expect(isImagePath('B.JPEG')).toBe(true);
    expect(isImagePath('c.webp')).toBe(true);
    expect(isImagePath('d.txt')).toBe(false);
    expect(isImagePath('')).toBe(false);
  });
});

describe('convTitle', () => {
  it('uses the first user message, clamped to 24 chars', () => {
    const msgs = [{ role: 'assistant', text: '你好' }, { role: 'user', text: '帮我把这个超长的标题截断到二十四个字符以内好不好谢谢你' }];
    const t = convTitle(msgs, '新对话');
    expect(t.length).toBeLessThanOrEqual(24);
    expect(t.startsWith('帮我把这个超长')).toBe(true);
  });
  it('falls back when there is no user message', () => {
    expect(convTitle([{ role: 'assistant', text: 'hi' }], '新对话')).toBe('新对话');
    expect(convTitle([], '')).toBe('新对话');
  });
});

describe('conversationToMarkdown', () => {
  it('renders user and assistant turns and strips suggestions blocks', () => {
    const md = conversationToMarkdown({
      title: '测试',
      messages: [
        { role: 'user', text: '画个柱状图' },
        { role: 'assistant', text: '好的。\n```suggestions\n再来一个\n```' },
      ],
    });
    expect(md).toContain('# 测试');
    expect(md).toContain('**我：** 画个柱状图');
    expect(md).toContain('**Kimi：** 好的。');
    expect(md).not.toContain('suggestions');
  });
});
