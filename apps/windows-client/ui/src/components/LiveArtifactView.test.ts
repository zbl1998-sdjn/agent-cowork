import { describe, expect, it } from 'vitest';
import { liveArtifactViewState } from './LiveArtifactView';

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
    })).toMatchObject({
      hasArtifact: true,
      canRefresh: true,
      canOpen: true,
      refreshLabel: '刷新数据',
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
    })).toMatchObject({
      canRefresh: false,
      canOpen: true,
      refreshLabel: '刷新中...',
      statusText: '刷新失败',
    });
  });
});
