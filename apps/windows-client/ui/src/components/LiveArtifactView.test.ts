import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AUTO_REFRESH_SECONDS,
  MAX_AUTO_REFRESH_SECONDS,
  MIN_AUTO_REFRESH_SECONDS,
  liveArtifactViewState,
  normaliseAutoRefreshSeconds,
} from './LiveArtifactView';

describe('liveArtifactViewState', () => {
  it('disables refresh before an artifact exists', () => {
    expect(liveArtifactViewState({})).toMatchObject({
      hasArtifact: false,
      canRefresh: false,
      canOpen: false,
      statusText: '尚未生成活页',
    });
  });

  it('enables refresh and open when a live artifact has data and a file', () => {
    expect(liveArtifactViewState({
      srcDoc: '<html></html>',
      dataUrl: '/api/artifacts/data/viz_1',
      filePath: 'C:/work/.AgentCowork/artifacts/viz_1.html',
      autoRefresh: true,
      autoRefreshSeconds: 2,
    })).toMatchObject({
      hasArtifact: true,
      canRefresh: true,
      canAutoRefresh: true,
      autoRefresh: true,
      autoRefreshSeconds: 2,
      canOpen: true,
      refreshLabel: '刷新数据',
      autoRefreshLabel: '自动刷新 2s',
      statusText: '活页已就绪',
    });
  });

  it('surfaces busy and refresh error state', () => {
    expect(liveArtifactViewState({
      srcDoc: '<html></html>',
      dataUrl: '/api/artifacts/data/viz_1',
      filePath: 'C:/work/.AgentCowork/artifacts/viz_1.html',
      refreshing: true,
      error: '刷新失败',
      autoRefresh: true,
    })).toMatchObject({
      canRefresh: false,
      canAutoRefresh: true,
      autoRefresh: false,
      canOpen: true,
      refreshLabel: '刷新中...',
      statusText: '刷新失败',
    });
  });

  it('clamps auto refresh interval to the supported range', () => {
    expect(normaliseAutoRefreshSeconds('not-a-number')).toBe(DEFAULT_AUTO_REFRESH_SECONDS);
    expect(normaliseAutoRefreshSeconds(-1)).toBe(MIN_AUTO_REFRESH_SECONDS);
    expect(normaliseAutoRefreshSeconds(999)).toBe(MAX_AUTO_REFRESH_SECONDS);
    expect(normaliseAutoRefreshSeconds(3.8)).toBe(3);
  });
});
