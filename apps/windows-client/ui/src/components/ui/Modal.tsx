import type { CSSProperties, ReactNode } from 'react';
import { IconButton } from './Button';

// UI primitive (FE-2a): modal dialog. Renders nothing when closed. Accessible
// (role=dialog, aria-modal, labelled by title). Clicking the overlay or the
// close button calls onClose; clicks inside the dialog don't bubble out.

export interface ModalProps {
  open: boolean;
  title?: string;
  onClose?: () => void;
  children?: ReactNode;
  footer?: ReactNode;
}

const overlayStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.4)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1000,
};
const dialogStyle: CSSProperties = {
  background: 'var(--surface, #fff)',
  color: 'var(--fg, #374151)',
  borderRadius: 10,
  minWidth: 320,
  maxWidth: '90vw',
  maxHeight: '85vh',
  overflow: 'auto',
  boxShadow: '0 10px 40px rgba(0,0,0,0.25)',
};
const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  padding: '12px 16px',
  borderBottom: '1px solid var(--border, #e5e7eb)',
};

export function Modal({ open, title, onClose, children, footer }: ModalProps) {
  if (!open) {
    return null;
  }
  return (
    <div className="ui-modal__overlay" role="presentation" style={overlayStyle} onClick={onClose}>
      <div
        className="ui-modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={dialogStyle}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="ui-modal__header" style={headerStyle}>
          <div className="ui-modal__title" style={{ fontSize: 14, fontWeight: 600 }}>{title}</div>
          {onClose ? (
            <IconButton label="关闭" onClick={onClose}>
              ×
            </IconButton>
          ) : null}
        </div>
        <div className="ui-modal__body" style={{ padding: 16 }}>{children}</div>
        {footer ? (
          <div
            className="ui-modal__footer"
            style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '12px 16px', borderTop: '1px solid var(--border, #e5e7eb)' }}
          >
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default Modal;
