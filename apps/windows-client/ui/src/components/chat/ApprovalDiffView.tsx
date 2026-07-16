// ApprovalDiffView(UI · components/chat):把 Write/Edit 审批预览渲染成逐行 diff（+/- 标记）。
// 二进制内容只报字节数；改动过大跳过逐行 diff,回退到整块 before/after。
// 路径与内容渲染前经 neutralizeInvisibleDirectives 可见化 bidi/零宽字符,防审批视觉欺骗。纯展示。
import { neutralizeInvisibleDirectives } from '../../lib/approval-text-guard';
import { computeLineDiff } from '../../lib/text-diff';

export type TextDiffPreview = { kind: 'text'; path: string; before: string | null; after: string };
export type BinaryDiffPreview = { kind: 'binary'; path: string; beforeBytes: number | null; afterBytes: number };
export type ApprovalDiffPreview = TextDiffPreview | BinaryDiffPreview;

export function isDiffPreview(value: unknown): value is ApprovalDiffPreview {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (record.kind === 'text' || record.kind === 'binary') && typeof record.path === 'string';
}

function BinaryPreview({ preview }: { preview: BinaryDiffPreview }) {
  const before = preview.beforeBytes == null ? '新建文件' : `${preview.beforeBytes} 字节`;
  return (
    <div className="approval-diff approval-diff--binary">
      <div className="approval-diff-path">{neutralizeInvisibleDirectives(preview.path)}</div>
      <p>二进制内容，无法显示逐行差异（{before} → {preview.afterBytes} 字节）。</p>
    </div>
  );
}

function TextPreview({ preview }: { preview: TextDiffPreview }) {
  const isNewFile = preview.before == null;
  const lines = computeLineDiff(preview.before ?? '', preview.after);
  return (
    <div className="approval-diff">
      <div className="approval-diff-path">{isNewFile && <span className="approval-diff-new-badge">新建文件</span>}{neutralizeInvisibleDirectives(preview.path)}</div>
      {lines === null ? (
        <div className="approval-diff-toobig">
          <p>改动过大，不逐行显示；以下分别是修改前/修改后：</p>
          {preview.before != null && <pre className="approval-diff-block">{neutralizeInvisibleDirectives(preview.before)}</pre>}
          <pre className="approval-diff-block">{neutralizeInvisibleDirectives(preview.after)}</pre>
        </div>
      ) : (
        <pre className="approval-diff-lines">
          {lines.map((line, index) => (
            <div key={index} className={`approval-diff-line is-${line.type}`}>
              <span className="approval-diff-marker">{line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' '}</span>
              <span>{neutralizeInvisibleDirectives(line.text)}</span>
            </div>
          ))}
        </pre>
      )}
    </div>
  );
}

export function ApprovalDiffView({ preview }: { preview: ApprovalDiffPreview }) {
  return preview.kind === 'binary' ? <BinaryPreview preview={preview} /> : <TextPreview preview={preview} />;
}
