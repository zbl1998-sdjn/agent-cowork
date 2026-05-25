import type { CSSProperties } from 'react';

// UI primitive (05-B2): right-click context menu. Renders nothing when closed.
// Positioned at (x, y); clicking an item fires its onSelect then closes;
// clicking the overlay (or right-clicking it) closes. Accessible (role=menu /
// menuitem). Self-contained, inline styling, no deps.

export interface ContextMenuItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
}

export interface ContextMenuProps {
  open: boolean;
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose?: () => void;
}

const overlayStyle: CSSProperties = { position: 'fixed', inset: 0, zIndex: 1000 };
const menuStyle: CSSProperties = {
  position: 'fixed',
  minWidth: 160,
  padding: 4,
  borderRadius: 8,
  background: 'var(--surface, #fff)',
  color: 'var(--fg, #374151)',
  border: '1px solid var(--border, #e5e7eb)',
  boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
};
const itemStyle: CSSProperties = {
  display: 'block',
  width: '100%',
  textAlign: 'left',
  padding: '6px 10px',
  fontSize: 13,
  border: 'none',
  borderRadius: 6,
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
};

export function ContextMenu({ open, x, y, items, onClose }: ContextMenuProps) {
  if (!open) {
    return null;
  }
  return (
    <div
      className="ui-context-overlay"
      role="presentation"
      style={overlayStyle}
      onClick={onClose}
      onContextMenu={(event) => {
        event.preventDefault();
        onClose?.();
      }}
    >
      <div
        className="ui-context-menu"
        role="menu"
        style={{ ...menuStyle, left: x, top: y }}
        onClick={(event) => event.stopPropagation()}
      >
        {items.map((item, index) => (
          <button
            key={`${item.label}-${index}`}
            type="button"
            role="menuitem"
            className="ui-context-menu__item"
            disabled={item.disabled}
            style={{
              ...itemStyle,
              ...(item.danger ? { color: 'var(--danger, #b91c1c)' } : {}),
              ...(item.disabled ? { opacity: 0.5, cursor: 'not-allowed' } : {}),
            }}
            onClick={() => {
              if (item.disabled) return;
              item.onSelect();
              onClose?.();
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export default ContextMenu;
