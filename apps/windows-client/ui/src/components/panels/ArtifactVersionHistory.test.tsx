import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ArtifactVersionHistoryList } from './ArtifactVersionHistory';

describe('ArtifactVersionHistory', () => {
  it('shows immutable version ancestry without offering an unapproved restore action', () => {
    const html = renderToStaticMarkup(<ArtifactVersionHistoryList versions={[
      {
        id: 'viz_report_v2',
        lineageId: 'viz_report_v1',
        parentVersionId: 'viz_report_v1',
        contentSha256: 'b'.repeat(64),
        hashVerified: true,
        title: 'Report',
        createdAt: '2026-07-12T02:00:00.000Z',
        viewUrl: '/api/artifacts/live/viz_report_v2',
      },
      {
        id: 'viz_report_v1',
        lineageId: 'viz_report_v1',
        contentSha256: 'a'.repeat(64),
        hashVerified: true,
        title: 'Report',
        createdAt: '2026-07-12T01:00:00.000Z',
        viewUrl: '/api/artifacts/live/viz_report_v1',
      },
    ]} />);

    expect(html).toContain('viz_report_v2');
    expect(html).toContain('父版本 viz_report_v1');
    expect(html).toContain('哈希已验证');
    expect(html).not.toContain('恢复');
    expect(html).not.toContain('restore');
  });
});
