// Explicit two-step UI for publishing an immutable live-artifact version (UI · components).
import { useState } from 'react';

import {
  previewArtifactVersion,
  publishArtifactVersion,
  type ArtifactVersionDraft,
  type ArtifactVersionPreview,
} from '../../lib/api';
import { humanizeError } from '../../lib/friendly-error';
import { Button } from '../ui/Button';

const MAX_DRAFT_CHARS = 200_000;

export function parseArtifactVersionDraft(text: string): ArtifactVersionDraft {
  if (text.length > MAX_DRAFT_CHARS) throw new Error('version draft is too large');
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('version draft must be a JSON object');
  }
  const draft = value as Record<string, unknown>;
  if (draft.id !== undefined && typeof draft.id !== 'string') {
    throw new Error('version id must be a string');
  }
  if (draft.title !== undefined && typeof draft.title !== 'string') {
    throw new Error('version title must be a string');
  }
  if (draft.viz !== undefined
    && (!draft.viz || typeof draft.viz !== 'object' || Array.isArray(draft.viz))) {
    throw new Error('version viz must be a JSON object');
  }
  return draft as ArtifactVersionDraft;
}

export function ArtifactVersionCreateForm({
  draftText,
  busy,
  onDraftTextChange,
  onPrepare,
  onCancel,
}: {
  draftText: string;
  busy: boolean;
  onDraftTextChange: (value: string) => void;
  onPrepare: () => void;
  onCancel: () => void;
}) {
  return (
    <>
      <p className="panel-note">
        输入可选的 title、viz 或 dataSource；留空沿用父版本。准备阶段只生成精确写入计划，不落盘。
      </p>
      <textarea
        aria-label="新版本 JSON"
        value={draftText}
        rows={8}
        spellCheck={false}
        disabled={busy}
        onChange={(event) => onDraftTextChange(event.target.value)}
      />
      <div className="panel-row">
        <Button variant="primary" disabled={busy} onClick={onPrepare}>{busy ? '准备中…' : '准备发布'}</Button>
        <Button variant="secondary" disabled={busy} onClick={onCancel}>取消</Button>
      </div>
    </>
  );
}

export function ArtifactVersionApprovalReview({
  preview,
  busy,
  onPublish,
  onBack,
}: {
  preview: ArtifactVersionPreview;
  busy: boolean;
  onPublish: () => void;
  onBack: () => void;
}) {
  return (
    <>
      <p className="panel-note">将新增不可变版本，不覆盖父版本：</p>
      <dl>
        <dt>新版本</dt><dd><code>{preview.id}</code></dd>
        <dt>父版本</dt><dd><code>{preview.parentVersionId}</code></dd>
        <dt>标题</dt><dd>{preview.title}</dd>
        <dt>可视化</dt><dd><code>{preview.vizKind}</code></dd>
        <dt>数据源</dt><dd><code>{preview.dataSourceType}</code>（参数已脱敏）</dd>
        <dt>父内容哈希</dt><dd><code>{preview.parentContentSha256}</code></dd>
        <dt>精确计划摘要</dt><dd><code>{preview.approvalPlanSha256}</code></dd>
        <dt>写入动作</dt><dd>{preview.operationCount}</dd>
        <dt>写入位置</dt><dd><code>{preview.relativePath}</code></dd>
      </dl>
      <div className="panel-row">
        <Button variant="primary" disabled={busy} onClick={onPublish}>
          {busy ? '发布中…' : '确认发布新版本'}
        </Button>
        <Button variant="secondary" disabled={busy} onClick={onBack}>返回修改</Button>
      </div>
    </>
  );
}

export function ArtifactVersionCreate({
  parentVersionId,
  trustedRoot,
  onPublished,
  onCancel,
}: {
  parentVersionId: string;
  trustedRoot: string;
  onPublished: (id: string) => void;
  onCancel: () => void;
}) {
  const [draftText, setDraftText] = useState('{}');
  const [preparedDraft, setPreparedDraft] = useState<ArtifactVersionDraft | null>(null);
  const [preview, setPreview] = useState<ArtifactVersionPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const prepare = async () => {
    setBusy(true);
    setError('');
    try {
      const draft = parseArtifactVersionDraft(draftText);
      setPreview(await previewArtifactVersion(parentVersionId, draft, trustedRoot));
      setPreparedDraft(draft);
    } catch (cause) {
      setError(humanizeError(cause, { action: '准备产物新版本' }));
    } finally {
      setBusy(false);
    }
  };

  const publish = async () => {
    if (!preview || !preparedDraft) return;
    setBusy(true);
    setError('');
    try {
      const result = await publishArtifactVersion(parentVersionId, preparedDraft, preview, trustedRoot);
      onPublished(result.id);
    } catch (cause) {
      setError(humanizeError(cause, { action: '发布产物新版本' }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="observe-detail" aria-label="创建产物新版本" aria-busy={busy}>
      <div className="observe-head"><h3>创建新版本</h3></div>
      {preview ? (
        <ArtifactVersionApprovalReview
          preview={preview}
          busy={busy}
          onPublish={() => void publish()}
          onBack={() => { setPreview(null); setPreparedDraft(null); setError(''); }}
        />
      ) : (
        <ArtifactVersionCreateForm
          draftText={draftText}
          busy={busy}
          onDraftTextChange={setDraftText}
          onPrepare={() => void prepare()}
          onCancel={onCancel}
        />
      )}
      {error && <p role="alert">{error}</p>}
    </aside>
  );
}
