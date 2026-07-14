// WorkspaceSwitcher 工作区切换器(UI · 组件层 · components)
// ---------------------------------------------------------------------------
// 职责:通过 host 的 Connected-folder grant 注册表选择/切换工作区。UI 只持久化 opaque grant id,
//       不再把原始文件夹路径写入 localStorage。
// 依赖:hooks/useConnectedFolders + lib/api(isDesktop)+ lib/icons + ui/Button;@tauri-apps/plugin-dialog 动态导入。
import { useEffect, useRef, useState } from 'react';
import { useConnectedFolders } from '../hooks/useConnectedFolders';
import { useShortcuts } from '../hooks/useShortcuts';
import { isDesktop } from '../lib/api';
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
  const popupRef = useRef<HTMLDivElement>(null);
  const {
    grants,
    selectedId,
    busy,
    error,
    connect,
    select,
    revoke,
  } = useConnectedFolders(current, onSwitch);
  const selectedGrant = grants.find((grant) => grant.id === selectedId) ?? null;

  useEffect(() => { setInput(current); }, [current]);

  useEffect(() => {
    if (!open) return undefined;
    const onMouseDown = (event: MouseEvent) => {
      if (popupRef.current && !popupRef.current.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onMouseDown);
    return () => window.removeEventListener('mousedown', onMouseDown);
  }, [open]);

  useShortcuts({ escape: () => setOpen(false) }, { enabled: open });

  const apply = async (next: string, source: 'picker' | 'manual' = 'manual') => {
    const cleaned = next.trim();
    if (!cleaned) return;
    const existing = grants.find((grant) => grant.path === cleaned);
    if (existing) {
      select(existing);
      setOpen(false);
      return;
    }
    if (await connect(cleaned, source)) setOpen(false);
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
                if (picked) { setInput(picked); void apply(picked, 'picker'); }
              }}
              disabled={busy}
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
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') void apply(input); }}
            spellCheck={false}
          />
          {error && <p className="workspace-error" role="alert">⚠ {error}</p>}
          <div className="workspace-popup-actions">
            <Button variant="secondary" onClick={() => void apply(input)} disabled={busy || !input.trim()}>
              {busy ? '处理中…' : '连接并切换'}
            </Button>
            {selectedGrant && selectedGrant.source !== 'system' && (
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  if (globalThis.confirm?.(`撤销“${selectedGrant.displayName}”的文件夹授权？`)) {
                    void revoke(selectedGrant.id);
                  }
                }}
              >
                撤销当前授权
              </Button>
            )}
            <Button variant="secondary" onClick={() => setOpen(false)}>取消</Button>
          </div>
          {grants.length > 0 && (
            <>
              <div className="workspace-popup-sep">已连接文件夹</div>
              <ul className="workspace-recents">
                {grants.map((grant) => (
                  <li key={grant.id}>
                    <button
                      type="button"
                      className={grant.id === selectedId ? 'is-current' : ''}
                      onClick={() => { select(grant); setOpen(false); }}
                      title={grant.path}
                      disabled={busy}
                    >
                      {grant.displayName} · {abbreviatePath(grant.path, 42)}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
          <p className="workspace-popup-hint">授权由 host 按当前用户注册并加密保存；撤销后该 grantId 立即失效。</p>
        </div>
      )}
    </div>
  );
}
