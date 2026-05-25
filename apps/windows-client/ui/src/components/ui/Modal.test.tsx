import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Modal } from './Modal';

describe('Modal', () => {
  it('renders nothing when closed', () => {
    const html = renderToStaticMarkup(
      <Modal open={false} title="设置">
        <div>正文</div>
      </Modal>,
    );
    expect(html).toBe('');
  });

  it('renders an accessible dialog with title, body and close button when open', () => {
    const html = renderToStaticMarkup(
      <Modal open title="设置" onClose={() => {}}>
        <div>正文内容</div>
      </Modal>,
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('设置');
    expect(html).toContain('正文内容');
    expect(html).toContain('aria-label="关闭"');
  });

  it('omits the close button when no onClose is given', () => {
    const html = renderToStaticMarkup(
      <Modal open title="只读">
        <div>x</div>
      </Modal>,
    );
    expect(html).not.toContain('aria-label="关闭"');
  });
});
