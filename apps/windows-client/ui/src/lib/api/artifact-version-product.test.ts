import { beforeEach, describe, expect, it, vi } from 'vitest';

const transport = vi.hoisted(() => ({
  postJson: vi.fn(),
  newIdempotencyKey: vi.fn(() => 'artifact-version-idem-1'),
}));

vi.mock('./transport', () => ({
  authHeaders: vi.fn(() => ({})),
  getJson: vi.fn(),
  hostReady: Promise.resolve(true),
  newIdempotencyKey: transport.newIdempotencyKey,
  postJson: transport.postJson,
  resolveUrl: vi.fn((value: string) => value),
}));

import {
  previewArtifactVersion,
  publishArtifactVersion,
  type ArtifactVersionDraft,
  type ArtifactVersionPreview,
} from './artifacts';

describe('artifact version product API', () => {
  beforeEach(() => {
    transport.postJson.mockReset();
    transport.newIdempotencyKey.mockClear();
  });

  it('keeps approval preview and idempotent publication as two explicit requests', async () => {
    const draft: ArtifactVersionDraft = {
      title: 'Report v2',
      viz: { kind: 'table', data: { columns: ['a'], rows: [[2]] } },
    };
    const preview: ArtifactVersionPreview = {
      id: 'viz_report_v2',
      parentVersionId: 'viz_report_v1',
      relativePath: '.AgentCowork/artifacts/viz_report_v2.html',
      dataUrl: '/api/artifacts/data/viz_report_v2',
      viewUrl: '/api/artifacts/live/viz_report_v2',
      title: 'Report v2',
      vizKind: 'table',
      dataSourceType: 'inline',
      parentContentSha256: 'parent-sha256',
      approvalPlanSha256: 'approval-plan-sha256',
      operationCount: 2,
      fileOperationApprovalId: 'fop_artifact_version_1',
    };
    transport.postJson.mockResolvedValueOnce(preview).mockResolvedValueOnce({
      id: preview.id,
      parentVersionId: preview.parentVersionId,
      viewUrl: preview.viewUrl,
    });

    await expect(previewArtifactVersion('viz_report_v1', draft, 'C:/work')).resolves.toEqual(preview);
    await publishArtifactVersion('viz_report_v1', draft, preview, 'C:/work');

    expect(transport.postJson).toHaveBeenNthCalledWith(
      1,
      '/api/artifacts/live/viz_report_v1/versions/preview',
      { ...draft, trustedRoot: 'C:/work' },
    );
    expect(transport.postJson).toHaveBeenNthCalledWith(
      2,
      '/api/artifacts/live/viz_report_v1/versions',
      {
        ...draft,
        id: preview.id,
        trustedRoot: 'C:/work',
        fileOperationApprovalId: preview.fileOperationApprovalId,
        idempotencyKey: 'artifact-version-idem-1',
      },
    );
    expect(transport.newIdempotencyKey).toHaveBeenCalledWith('artifact-version');
  });
});
