import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  ArtifactVersionApprovalReview,
  ArtifactVersionCreateForm,
  parseArtifactVersionDraft,
} from './ArtifactVersionCreate';

describe('ArtifactVersionCreate', () => {
  it('validates an optional viz override without accepting non-object payloads', () => {
    expect(parseArtifactVersionDraft('{}')).toEqual({});
    expect(parseArtifactVersionDraft('{"title":"v2","viz":{"kind":"table"}}')).toEqual({
      title: 'v2',
      viz: { kind: 'table' },
    });
    expect(() => parseArtifactVersionDraft('[]')).toThrow(/JSON object/i);
    expect(() => parseArtifactVersionDraft('{"viz":"table"}')).toThrow(/viz/i);
  });

  it('shows a preparation action before any write approval is consumed', () => {
    const html = renderToStaticMarkup(<ArtifactVersionCreateForm
      draftText="{}"
      busy={false}
      onDraftTextChange={() => {}}
      onPrepare={() => {}}
      onCancel={() => {}}
    />);

    expect(html).toContain('准备发布');
    expect(html).not.toContain('确认发布新版本');
    expect(html).toContain('留空沿用父版本');
  });

  it('requires a distinct confirmation action after the exact write plan is visible', () => {
    const html = renderToStaticMarkup(<ArtifactVersionApprovalReview
      preview={{
        id: 'viz_report_v2',
        parentVersionId: 'viz_report_v1',
        relativePath: '.AgentCowork/artifacts/viz_report_v2.html',
        dataUrl: '/api/artifacts/data/viz_report_v2',
        viewUrl: '/api/artifacts/live/viz_report_v2',
        title: 'Quarterly report v2',
        vizKind: 'table',
        dataSourceType: 'inline',
        parentContentSha256: 'parent-sha256',
        approvalPlanSha256: 'approval-plan-sha256',
        operationCount: 2,
        fileOperationApprovalId: 'fop_1',
      }}
      busy={false}
      onPublish={() => {}}
      onBack={() => {}}
    />);

    expect(html).toContain('viz_report_v2');
    expect(html).toContain('.AgentCowork/artifacts/viz_report_v2.html');
    expect(html).toContain('Quarterly report v2');
    expect(html).toContain('table');
    expect(html).toContain('inline');
    expect(html).toContain('parent-sha256');
    expect(html).toContain('approval-plan-sha256');
    expect(html).toContain('2');
    expect(html).toContain('确认发布新版本');
    expect(html).not.toContain('恢复旧版本');
  });
});
