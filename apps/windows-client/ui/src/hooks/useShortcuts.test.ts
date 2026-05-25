import { describe, expect, it } from 'vitest';
import { matchShortcut, parseBinding } from './useShortcuts';

describe('parseBinding', () => {
  it('parses modifiers and the key, case-insensitively', () => {
    expect(parseBinding('Ctrl+Shift+P')).toEqual({
      key: 'p', ctrl: true, meta: false, shift: true, alt: false, mod: false,
    });
  });
  it('treats mod as a separate flag', () => {
    expect(parseBinding('mod+k').mod).toBe(true);
  });
});

describe('matchShortcut', () => {
  it('matches an exact ctrl+key combo', () => {
    expect(matchShortcut({ key: 'k', ctrlKey: true }, 'ctrl+k')).toBe(true);
  });
  it('is case-insensitive on the key', () => {
    expect(matchShortcut({ key: 'K', ctrlKey: true }, 'ctrl+k')).toBe(true);
  });
  it('mod matches Ctrl (Win/Linux)', () => {
    expect(matchShortcut({ key: 'k', ctrlKey: true }, 'mod+k')).toBe(true);
  });
  it('mod matches Cmd (macOS)', () => {
    expect(matchShortcut({ key: 'k', metaKey: true }, 'mod+k')).toBe(true);
  });
  it('mod requires at least one of ctrl/meta', () => {
    expect(matchShortcut({ key: 'k' }, 'mod+k')).toBe(false);
  });
  it('rejects an extra unrequested modifier', () => {
    expect(matchShortcut({ key: 'k', ctrlKey: true, shiftKey: true }, 'ctrl+k')).toBe(false);
  });
  it('matches a bare key like escape', () => {
    expect(matchShortcut({ key: 'escape' }, 'escape')).toBe(true);
  });
  it('matches ctrl+shift+p', () => {
    expect(matchShortcut({ key: 'p', ctrlKey: true, shiftKey: true }, 'ctrl+shift+p')).toBe(true);
  });
  it('rejects when the key differs', () => {
    expect(matchShortcut({ key: 'j', ctrlKey: true }, 'ctrl+k')).toBe(false);
  });
});
