// WorkspaceSwitcher 工作区切换器(UI · 组件层 · components)
// ---------------------------------------------------------------------------
// 职责:选择/切换当前受信任工作区根(Tauri 原生选目录或粘贴路径),切换前用 GET /api/projects?trustedRoot 预检 host path-policy,通过后经 onSwitch 回传并记入最近列表(localStorage)。
// 依赖:lib/api(getJson/isDesktop)+ lib/icons + ui/Button;@tauri-apps/plugin-dialog 动态导入。导出:组件 + 纯函数 pushRecentWorkspace / abbreviatePath。
import { useEffect, useRef, useState } from 'react';
import { getJson, isDesktop } from '../lib/api';
import { ICONS } from '../lib/icons';
import { Button } from './ui/Button';

// Tauri 原生目录选择器动态导入;浏览器/Vitest 环境拿不到插件时 bundle 仍可构建。
async function pickDirectory(defaultPath?: string): Promise<string | null> {
  if (!isDesktop()) return null;
  try {
    const module = await import('@tauri-apps/plugin-dialog');
    const result = await module.open({
      directory: true,
      multiple: false,
      ...(defaultPath ? { defaultPath } : {}),
    });
    return typeof result === 'string' && result ? result : null;
  } catch {
    return null;
  }
}

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
    /* storage 不可用时仅保留内存最近列表 */
  }
}

// 纯辅助:把 next 放到列表头部并去重,最多保留 MAX_RECENT 项。
export function pushRecentWorkspace(list: readonly string[], next: string): string[] {
  const cleaned = next.trim();
  if (!cleaned) return [...list];
  return [cleaned, ...list.filter((value) => value !== cleaned)].slice(0, MAX_RECENT);
}

// 纯辅助:把长路径折叠到顶部 chip 能容纳的长度。
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
    // 预检:让 host 以新根加载项目;host path-policy 会用 4xx 拒绝受信范围外路径。
    // 这里内联展示错误,避免用户切到一个会让所有面板静默失败的目录。
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
        {`${ICONS.FOLDER} ${abbreviatePath(current)} ▾`}
      </Button>
      {open && (
        <div className="workspace-popup" role="dialog" aria-label="切换工作区">
          <div className="workspace-popup-actions workspace-popup-pick">
            <Button
              variant="primary"
              onClick={async () => {
                const picked = await pickDirectory(input || current);
                if (picked) { setInput(picked); setValidateError(''); void apply(picked); }
              }}
              title="打开系统文件夹选择对话框"
            >
              📂 选择文件夹…
            </Button>
            <span className="workspace-popup-or">或粘贴路径</span>
          </div>
          <label className="workspace-popup-label" htmlFor="workspace-input">工作区路径</label>
          <input
            id="workspace-input"
            className="workspace-input"
            value={input}
            placeholder="如 C:\\Users\\you\\projects\\demo"
            onChange={(event) => { setInput(event.target.value); setValidateError(''); }}
            onKeyDown={(event) => { if (event.key === 'Enter') void apply(input); }}
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
