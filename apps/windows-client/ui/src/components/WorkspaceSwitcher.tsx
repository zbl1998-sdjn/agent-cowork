import { useEffect, useRef, useState } from 'react';
import { getJson } from '../lib/api';
import { Button } from './ui/Button';

const RECENT_KEY = 'kcw.recentWorkspaces';
const MAX_RECENT = 6;

function loadRecents(): string[] {
  try {
    const raw = globalThis.localStorage?.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((value) => typeof value === 'string') : [];
  } catch {
    return [];
  }
}

function persistRecents(items: string[]) {
  try {
    globalThis.localStorage?.setItem(RECENT_KEY, JSON.stringify(items.slice(0, MAX_RECENT)));
  } catch {
    /* storage unavailable — keep in-memory only */
  }
}

// Pure helper: place `next` at the head and dedupe, capped at MAX_RECENT.
export function pushRecentWorkspace(list: readonly string[], next: string): string[] {
  const cleaned = next.trim();
  if (!cleaned) return [...list];
  return [cleaned, ...list.filter((value) => value !== cleaned)].slice(0, MAX_RECENT);
}

// Pure helper: collapse a long path so it fits in the header chip.
export function abbreviatePath(value: string, max = 36): string {
  const path = (value || '').trim();
  if (path.length <= max) return path;
  return '…' + path.slice(-(max - 1));
}

interface WorkspaceSwitcherProps {
  current: string;
  onSwitch: (path: string) => void;
}

export function WorkspaceSwitcher({ current, onSwitch }: WorkspaceSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState(current);
  const [recents, setRecents] = useState<string[]>(loadRecents);
  const [validating, setValidating] = useState(false);
  const [validateError, setValidateError] = useState('');
  const popupRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setInput(current); }, [current]);
  useEffect(() => { if (!open) setValidateError(''); }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onMouseDown = (event: MouseEvent) => {
      if (popupRef.current && !popupRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const apply = async (next: string) => {
    const cleaned = next.trim();
    if (!cleaned || cleaned === current) { setOpen(false); return; }
    // Preflight: ask the host to load projects for the new root. The host's
    // path-policy will reject anything outside its configured trusted root with
    // a 4xx — surface the error inline instead of letting the user "switch" to
    // a path that silently breaks every panel.
    setValidating(true);
    setValidateError('');
    try {
      await getJson<unknown>(`/api/projects?trustedRoot=${encodeURIComponent(cleaned)}`);
    } catch (e) {
      const message = (e as Error).message || '';
      setValidateError(message.includes('escape') || message.toLowerCase().includes('trusted')
        ? `host 拒绝该路径(不在受信任范围内):${message}`
        : `路径验证失败:${message}`);
      setValidating(false);
      return;
    }
    setValidating(false);
    const updated = pushRecentWorkspace(recents, cleaned);
    setRecents(updated);
    persistRecents(updated);
    onSwitch(cleaned);
    setOpen(false);
  };

  return (
    <div className="workspace-switcher" ref={popupRef}>
      <Button
        className="workspace-chip"
        variant="secondary"
        onClick={() => setOpen((value) => !value)}
        title={`当前工作区:${current}\n点击切换`}
      >
        📁 {abbreviatePath(current)} ▾
      </Button>
      {open && (
        <div className="workspace-popup" role="dialog" aria-label="切换工作区">
          <label className="workspace-popup-label" htmlFor="workspace-input">工作区路径</label>
          <input
            id="workspace-input"
            className="workspace-input"
            value={input}
            placeholder="如 C:\\Users\\you\\projects\\demo"
            onChange={(event) => { setInput(event.target.value); setValidateError(''); }}
            onKeyDown={(event) => { if (event.key === 'Enter') void apply(input); }}
            autoFocus
            spellCheck={false}
          />
          {validateError && <p className="workspace-error" role="alert">⚠ {validateError}</p>}
          <div className="workspace-popup-actions">
            <Button variant="secondary" onClick={() => void apply(input)} disabled={validating || !input.trim() || input.trim() === current}>{validating ? '校验中…' : '切换'}</Button>
            <Button variant="secondary" onClick={() => setOpen(false)}>取消</Button>
          </div>
          {recents.length > 0 && (
            <>
              <div className="workspace-popup-sep">最近</div>
              <ul className="workspace-recents">
                {recents.map((path) => (
                  <li key={path}>
                    <button
                      type="button"
                      className={path === current ? 'is-current' : ''}
                      onClick={() => apply(path)}
                      title={path}
                    >
                      {abbreviatePath(path, 50)}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
          <p className="workspace-popup-hint">host 的 path-policy 会校验路径,不在受信任范围会被拒绝。</p>
        </div>
      )}
    </div>
  );
}
