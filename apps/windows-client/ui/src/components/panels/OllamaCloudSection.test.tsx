import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { OllamaCloudSection } from './OllamaCloudSection';

vi.mock('../../lib/api', () => ({
  ollamaCloudRecommended: vi.fn(() => Promise.resolve([])),
  ollamaCloudSignin: vi.fn(),
  ollamaCloudPull: vi.fn(),
}));

describe('OllamaCloudSection', () => {
  it('renders the sign-in entry and the zero-config value prop', () => {
    const html = renderToStaticMarkup(<OllamaCloudSection />);
    expect(html).toContain('Ollama 云');
    expect(html).toContain('登录 Ollama 云');
    expect(html).toContain('云端算力');
  });
});
