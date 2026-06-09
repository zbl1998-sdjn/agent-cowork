import { describe, expect, it } from 'vitest';
import { matchShortcut, parseBinding } from './useShortcuts';

describe('parseBinding', () => {
  it('parses modifiers and the key, case-insensitively', () => {
    // 绑定字符串大小写不应影响解析结果,否则配置和文案会变得脆弱。
    expect(parseBinding('Ctrl+Shift+P')).toEqual({
      key: 'p', ctrl: true, meta: false, shift: true, alt: false, mod: false,
    });
  });
  it('treats mod as a separate flag', () => {
    // mod 是跨平台抽象键,需要保留为单独标志再由匹配阶段映射 Ctrl/Cmd。
    expect(parseBinding('mod+k').mod).toBe(true);
  });
});

describe('matchShortcut', () => {
  it('matches an exact ctrl+key combo', () => {
    // 最基础的 Ctrl+Key 组合是快捷键匹配的主路径。
    expect(matchShortcut({ key: 'k', ctrlKey: true }, 'ctrl+k')).toBe(true);
  });
  it('is case-insensitive on the key', () => {
    // 浏览器事件里的 key 可能带大小写,匹配时必须统一归一化。
    expect(matchShortcut({ key: 'K', ctrlKey: true }, 'ctrl+k')).toBe(true);
  });
  it('mod matches Ctrl (Win/Linux)', () => {
    // Windows/Linux 下 mod 等价 Ctrl。
    expect(matchShortcut({ key: 'k', ctrlKey: true }, 'mod+k')).toBe(true);
  });
  it('mod matches Cmd (macOS)', () => {
    // macOS 下 mod 等价 Cmd/meta。
    expect(matchShortcut({ key: 'k', metaKey: true }, 'mod+k')).toBe(true);
  });
  it('mod requires at least one of ctrl/meta', () => {
    // 只有普通按键不能冒充 mod 组合。
    expect(matchShortcut({ key: 'k' }, 'mod+k')).toBe(false);
  });
  it('rejects an extra unrequested modifier', () => {
    // 多按了未声明修饰键应拒绝,避免快捷键误触。
    expect(matchShortcut({ key: 'k', ctrlKey: true, shiftKey: true }, 'ctrl+k')).toBe(false);
  });
  it('matches a bare key like escape', () => {
    // Escape 这类裸键不需要任何修饰键。
    expect(matchShortcut({ key: 'escape' }, 'escape')).toBe(true);
  });
  it('matches ctrl+shift+p', () => {
    // 多修饰键组合需要逐项匹配。
    expect(matchShortcut({ key: 'p', ctrlKey: true, shiftKey: true }, 'ctrl+shift+p')).toBe(true);
  });
  it('rejects when the key differs', () => {
    // 修饰键正确但主键不同仍应拒绝。
    expect(matchShortcut({ key: 'j', ctrlKey: true }, 'ctrl+k')).toBe(false);
  });
});
