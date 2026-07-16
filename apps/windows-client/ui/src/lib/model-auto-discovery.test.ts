import { describe, expect, it } from 'vitest';
import { shouldAutoDiscoverModels } from './model-auto-discovery';

const base = { tab: 'model', loading: false, testingConnection: false, providerRegion: 'local', hasModels: false, hasConnection: false };

describe('shouldAutoDiscoverModels', () => {
  it('auto-discovers only for local providers on the model tab with nothing loaded yet', () => {
    expect(shouldAutoDiscoverModels(base)).toBe(true);
  });

  it('never auto-fires for cloud providers (no silent egress)', () => {
    expect(shouldAutoDiscoverModels({ ...base, providerRegion: 'cn' })).toBe(false);
    expect(shouldAutoDiscoverModels({ ...base, providerRegion: 'global' })).toBe(false);
    expect(shouldAutoDiscoverModels({ ...base, providerRegion: undefined })).toBe(false);
  });

  it('stays quiet outside the model tab, while loading/testing, or once results exist', () => {
    expect(shouldAutoDiscoverModels({ ...base, tab: 'api' })).toBe(false);
    expect(shouldAutoDiscoverModels({ ...base, loading: true })).toBe(false);
    expect(shouldAutoDiscoverModels({ ...base, testingConnection: true })).toBe(false);
    expect(shouldAutoDiscoverModels({ ...base, hasModels: true })).toBe(false);
    expect(shouldAutoDiscoverModels({ ...base, hasConnection: true })).toBe(false);
  });
});
