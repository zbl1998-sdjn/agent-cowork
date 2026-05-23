import { useEffect, useRef, useState } from 'react';

export interface Command { id: string; label: string; hint?: string; run: () => void }

// Cmd/Ctrl+K command palette: fuzzy-filter + keyboard-navigate app actions.
export function CommandPalette({ commands, onClose }: { commands: Command[]; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  const filtered = commands.filter((c) => !q || c.label.toLowerCase().includes(q.toLowerCase()));
  const run = (c?: Command) => { if (c) { c.run(); onClose(); } };

  return (
    <div className="cmdk-overlay" onClick={onClose}>
      <div className="cmdk" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="cmdk-input"
          placeholder="输入命令…  (Esc 关闭)"
          value={q}
          onChange={(e) => { setQ(e.target.value); setActive(0); }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { onClose(); }
            else if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(filtered.length - 1, a + 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
            else if (e.key === 'Enter') { e.preventDefault(); run(filtered[active]); }
          }}
        />
        <div className="cmdk-list">
          {filtered.map((c, i) => (
            <button
              key={c.id}
              type="button"
              className={'cmdk-item' + (i === active ? ' is-active' : '')}
              onMouseEnter={() => setActive(i)}
              onClick={() => run(c)}
            >
              <span>{c.label}</span>
              {c.hint && <span className="cmdk-hint">{c.hint}</span>}
            </button>
          ))}
          {filtered.length === 0 && <div className="cmdk-empty">没有匹配的命令</div>}
        </div>
      </div>
    </div>
  );
}
