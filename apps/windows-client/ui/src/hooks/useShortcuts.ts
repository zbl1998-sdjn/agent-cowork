// useShortcuts(UI · hooks 层)
// ---------------------------------------------------------------------------
// 职责:注册全局键盘快捷键(发送、新建会话、聚焦输入、停止等)并在卸载时清理,集中管理避免散落各组件。依赖:无。
import { useEffect } from 'react';

// 快捷键注册表:parseBinding/matchShortcut 是无 DOM 的纯核心,可完整单测。
// useShortcuts 只是把 "binding -> handler" 映射绑定到 keydown;binding 形如
// "ctrl+k"、"mod+shift+p"、"escape";"mod" 在 Windows/Linux 上匹配 Ctrl,在 macOS 上匹配 Cmd。

export interface ShortcutEvent {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}

export interface ParsedBinding {
  key: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  alt: boolean;
  mod: boolean;
}

export function parseBinding(binding: string): ParsedBinding {
  const parsed: ParsedBinding = { key: '', ctrl: false, meta: false, shift: false, alt: false, mod: false };
  for (const raw of String(binding).toLowerCase().split('+')) {
    const part = raw.trim();
    if (!part) continue;
    if (part === 'ctrl' || part === 'control') parsed.ctrl = true;
    else if (part === 'meta' || part === 'cmd' || part === 'command' || part === 'win') parsed.meta = true;
    else if (part === 'shift') parsed.shift = true;
    else if (part === 'alt' || part === 'option') parsed.alt = true;
    else if (part === 'mod') parsed.mod = true;
    else parsed.key = part;
  }
  return parsed;
}

export function matchShortcut(event: ShortcutEvent, binding: string): boolean {
  const b = parseBinding(binding);
  if ((event.key || '').toLowerCase() !== b.key) return false;

  const ctrl = !!event.ctrlKey;
  const meta = !!event.metaKey;
  const shift = !!event.shiftKey;
  const alt = !!event.altKey;

  if (b.shift !== shift) return false;
  if (b.alt !== alt) return false;

  if (b.mod) {
    // "mod" 跨平台匹配 Ctrl(Win/Linux)或 Cmd(macOS)。
    return ctrl || meta;
  }
  return b.ctrl === ctrl && b.meta === meta;
}

export type ShortcutMap = Record<string, (event: KeyboardEvent) => void>;

export interface UseShortcutsOptions {
  enabled?: boolean;
}

export function useShortcuts(map: ShortcutMap, options: UseShortcutsOptions = {}) {
  const { enabled = true } = options;
  useEffect(() => {
    if (!enabled) return undefined;
    const handler = (event: KeyboardEvent) => {
      for (const [binding, fn] of Object.entries(map)) {
        if (matchShortcut(event, binding)) {
          event.preventDefault();
          fn(event);
          break;
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [map, enabled]);
}
