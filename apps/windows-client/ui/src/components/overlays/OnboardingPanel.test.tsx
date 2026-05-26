import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { OnboardingPanel } from './OnboardingPanel';

describe('OnboardingPanel', () => {
  it('renders onboarding actions with Button primitives', () => {
    const html = renderToStaticMarkup(
      <OnboardingPanel onComplete={vi.fn()} onOpenSettings={vi.fn()} onOpenSettingsTab={vi.fn()} />,
    );

    expect(html).toContain('aria-label="首启引导"');
    expect(html).toContain('class="ui-icon-btn onboarding-close"');
    expect(html).toContain('aria-label="关闭首启引导"');
    expect(html).toContain('ui-btn ui-btn--secondary');
    expect(html).toContain('onboarding-setup-action');
    expect(html).toContain('btn-secondary');
    expect(html).toContain('btn-primary');
    expect(html).toContain('进入设置');
  });
});
