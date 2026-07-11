// ArtifactsPanel 产物面板(UI · 组件层 · components/panels)
// ---------------------------------------------------------------------------
// 职责:列出工作区下智能体保存的产物,支持刷新、在系统中打开、重命名;含大小/元信息格式化与重命名名校验等纯函数。
// 依赖:lib/api(listArtifacts/openPath/renameArtifact)+ ui/Button/Input/StateViews。关键 props:trustedRoot。
import type { ChangeEvent, KeyboardEvent } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { listArtifacts, openPath, renameArtifact, type ArtifactItem } from '../../lib/api';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Empty, ErrorState } from '../ui/StateViews';
import { ArtifactVersionCreate } from './ArtifactVersionCreate';
import { ArtifactVersionHistory } from './ArtifactVersionHistory';

interface ArtifactsPanelProps { trustedRoot: string }

export function humanArtifactSize(n?: number): string {
  if (!n || n < 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function artifactMeta(item: ArtifactItem): string {
  const parts = [artifactFriendlyKind(item)];
  const size = humanArtifactSize(item.size);
  if (size) parts.push(size);
  return parts.join(' · ');
}

export function artifactFriendlyKind(item: ArtifactItem): string {
  const name = item.name.toLowerCase();
  if (name.endsWith('.docx')) return 'Word';
  if (name.endsWith('.xlsx')) return 'Excel';
  if (name.endsWith('.pptx')) return 'PPT';
  if (name.endsWith('.pdf')) return 'PDF';
  if (name.endsWith('.csv')) return 'CSV 表格';
  if (name.endsWith('.txt')) return '可复制文本';
  if (name.endsWith('.md') || item.kind === 'markdown') return '草稿文本';
  if (name.endsWith('.html') || name.endsWith('.htm') || item.kind === 'html') return '网页预览';
  return item.kind || '文件';
}

export function sanitizeArtifactRename(value: string): string {
  const name = value.trim();
  if (!name) return '';
  if (name.includes('/') || name.includes('\\') || name === '.' || name === '..') return '';
  return name;
}

export function ArtifactsPanelStateViews({ error, onRetry }: { error: string; onRetry: () => void }) {
  if (error) {
    return <ErrorState title="产物加载失败" message={error} onRetry={onRetry} retryLabel="重新加载" />;
  }
  return <Empty title="还没有成果" message="完成一次任务后，Word、Excel、PPT、PDF、可复制文本或 CSV 会出现在这里。" />;
}

export interface ArtifactPanelItemProps {
  item: ArtifactItem;
  busy: boolean;
  renaming: boolean;
  renameText: string;
  onRenameTextChange: (value: string) => void;
  onCommitRename: (item: ArtifactItem) => void;
  onCancelRename: () => void;
  onOpen: (path: string) => void;
  onBeginRename: (item: ArtifactItem) => void;
  onCreateVersion?: (artifactId: string) => void;
  onViewHistory?: (artifactId: string) => void;
}

export function ArtifactPanelItem({
  item,
  busy,
  renaming,
  renameText,
  onRenameTextChange,
  onCommitRename,
  onCancelRename,
  onOpen,
  onBeginRename,
  onCreateVersion,
  onViewHistory,
}: ArtifactPanelItemProps) {
  const liveArtifactId = item.liveArtifactId;
  const onRenameKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      onCommitRename(item);
    }
  };
  return (
    <li className="artifact-panel-card" key={item.path}>
      <div className="artifact-panel-head">
        <code>{item.name}</code>
        <span>{artifactMeta(item)}</span>
      </div>
      {item.relativePath && <p>{item.relativePath}</p>}
      {renaming && (
        <div className="panel-row">
          <Input
            aria-label={`重命名 ${item.name}`}
            value={renameText}
            onChange={(event: ChangeEvent<HTMLInputElement>) => onRenameTextChange(event.target.value)}
            onKeyDown={onRenameKeyDown}
          />
          <Button variant="primary" disabled={busy || !sanitizeArtifactRename(renameText)} onClick={() => onCommitRename(item)}>保存</Button>
          <Button variant="secondary" disabled={busy} onClick={onCancelRename}>取消</Button>
        </div>
      )}
      <div className="panel-row">
        <Button variant="secondary" onClick={() => onOpen(item.path)}>打开</Button>
        {!liveArtifactId && (
          <Button variant="secondary" disabled={busy} onClick={() => onBeginRename(item)}>重命名</Button>
        )}
        {liveArtifactId && onCreateVersion && (
          <Button variant="secondary" disabled={busy} onClick={() => onCreateVersion(liveArtifactId)}>
            创建新版本
          </Button>
        )}
        {liveArtifactId && onViewHistory && (
          <Button variant="secondary" disabled={busy} onClick={() => onViewHistory(liveArtifactId)}>
            版本历史
          </Button>
        )}
      </div>
    </li>
  );
}

export function ArtifactsPanel({ trustedRoot }: ArtifactsPanelProps) {
  const [items, setItems] = useState<ArtifactItem[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [renamingPath, setRenamingPath] = useState('');
  const [renameText, setRenameText] = useState('');
  const [versionParentId, setVersionParentId] = useState('');
  const [historyId, setHistoryId] = useState('');

  const refresh = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      setItems(await listArtifacts(trustedRoot, 50));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [trustedRoot]);

  useEffect(() => { void refresh(); }, [refresh]);

  const beginRename = (item: ArtifactItem) => {
    setError('');
    setRenamingPath(item.path);
    setRenameText(item.name);
  };

  const commitRename = async (item: ArtifactItem) => {
    const newName = sanitizeArtifactRename(renameText);
    if (!newName) {
      setError('请输入有效文件名，不能包含路径分隔符。');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await renameArtifact(item.path, newName, trustedRoot);
      setRenamingPath('');
      setRenameText('');
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="side-panel">
      <h2>成果</h2>
      <p className="panel-intro">这里优先展示白领常用格式：Word、Excel、PPT、PDF、可复制文本和 CSV。默认生成副本，不会覆盖原文件。</p>
      <div className="artifact-format-strip" aria-label="常用成果格式">
        {['Word', 'Excel', 'PPT', 'PDF', '文本', 'CSV'].map((format) => <span key={format}>{format}</span>)}
      </div>
      <div className="panel-row">
        <Button variant="secondary" disabled={busy} onClick={() => void refresh()}>{busy ? '刷新中…' : '刷新'}</Button>
      </div>
      <ul className="artifact-list">
        {items.map((it) => (
          <ArtifactPanelItem
            key={it.path}
            item={it}
            busy={busy}
            renaming={renamingPath === it.path}
            renameText={renameText}
            onRenameTextChange={setRenameText}
            onCommitRename={(item) => void commitRename(item)}
            onCancelRename={() => { setRenamingPath(''); setRenameText(''); }}
            onOpen={(targetPath) => void openPath(targetPath)}
            onBeginRename={beginRename}
            onCreateVersion={(artifactId) => { setHistoryId(''); setVersionParentId(artifactId); }}
            onViewHistory={setHistoryId}
          />
        ))}
        {items.length === 0 && !error && (
          <li className="panel-empty">
            <ArtifactsPanelStateViews error="" onRetry={() => void refresh()} />
          </li>
        )}
      </ul>
      {versionParentId && (
        <ArtifactVersionCreate
          parentVersionId={versionParentId}
          trustedRoot={trustedRoot}
          onPublished={(artifactId) => {
            setVersionParentId('');
            setHistoryId(artifactId);
            void refresh();
          }}
          onCancel={() => setVersionParentId('')}
        />
      )}
      {historyId && (
        <ArtifactVersionHistory
          artifactId={historyId}
          trustedRoot={trustedRoot}
          onClose={() => setHistoryId('')}
        />
      )}
      {error && <ArtifactsPanelStateViews error={error} onRetry={() => void refresh()} />}
    </section>
  );
}
