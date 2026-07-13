// 统一 Office/Web 可视化编辑器(UI · 组件层 · components/office)
// ---------------------------------------------------------------------------
// 职责:组合格式导航、实时画布和所选对象检查器；所有状态/保存副作用交给 useOfficeVisualEditor。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useOfficeVisualEditor } from '../../hooks/useOfficeVisualEditor';
import { useOnlyOfficeEditor } from '../../hooks/useOnlyOfficeEditor';
import { supportsOnlyOffice, type ArtifactItem, type OfficeEditorKind } from '../../lib/api';
import type {
  WebComponentNode,
  WebEditorCommand,
  WebEditorCommandInput,
  WebElementSelection,
} from '../../lib/types/webEditor';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { ErrorState, Loading } from '../ui/StateViews';
import { OfficeFormatCanvas } from './OfficeFormatCanvas';
import { WebComponentTree } from './WebComponentTree';
import { WebEditorInspector } from './WebEditorInspector';
import { WebPageCanvas } from './WebPageCanvas';

export { OfficeFormatCanvas } from './OfficeFormatCanvas';

const SUPPORTED_RE = /\.(docx|xlsx|pptx|html?)$/i;
const KIND_LABEL: Record<OfficeEditorKind, string> = {
  docx: 'Word 段落', xlsx: 'Excel 单元格', pptx: 'PPT 文本框', html: '网页组件',
};

export function supportsVisualEditing(name: string): boolean {
  return SUPPORTED_RE.test(name);
}

export function defaultEditedCopyName(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? `${name.slice(0, dot)}-可视化编辑${name.slice(dot)}` : `${name}-可视化编辑`;
}

export function OfficeVisualEditor({
  item,
  trustedRoot,
  onClose,
  onSaved,
}: {
  item: ArtifactItem;
  trustedRoot: string;
  onClose: () => void;
  onSaved: (path: string) => void;
}) {
  const editor = useOfficeVisualEditor(item, trustedRoot, onSaved);
  const onlyOffice = useOnlyOfficeEditor(item, trustedRoot, onSaved);
  const [copyName, setCopyName] = useState(() => defaultEditedCopyName(item.name));
  const [webSelection, setWebSelection] = useState<WebElementSelection | null>(null);
  const [webTree, setWebTree] = useState<WebComponentNode[]>([]);
  const [webCommand, setWebCommand] = useState<WebEditorCommand | null>(null);
  const [structureCollapsed, setStructureCollapsed] = useState(false);
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
  const webCommandId = useRef(0);
  useEffect(() => setCopyName(defaultEditedCopyName(item.name)), [item.name]);
  useEffect(() => {
    setWebSelection(null);
    setWebTree([]);
    setWebCommand(null);
  }, [item.path]);
  const sendWebCommand = useCallback((command: WebEditorCommandInput) => {
    webCommandId.current += 1;
    setWebCommand({ ...command, id: webCommandId.current } as WebEditorCommand);
  }, []);
  const selected = useMemo(() => editor.session?.sections
    .flatMap((section) => section.nodes)
    .find((node) => node.id === editor.selectedId), [editor.selectedId, editor.session]);

  if (onlyOffice.session) {
    return (
      <section className="office-editor-shell onlyoffice-editor-mode">
        <header className="office-editor-header">
          <div><span className="office-format-badge">ONLYOFFICE 全功能编辑</span><h2>{item.name}</h2><p>编辑内容由 Document Server 自动缓存；关闭编辑器后发布为已审批副本。</p></div>
          <Button variant="secondary" onClick={onlyOffice.close}>返回组件编辑</Button>
        </header>
        <div className="onlyoffice-frame-shell">
          <iframe title={`ONLYOFFICE 编辑 ${item.name}`} src={onlyOffice.session.editorUrl} allow="clipboard-read; clipboard-write" />
        </div>
        <div className="onlyoffice-status-bar">
          <span><i className="is-online" />Document Server 已连接</span>
          <span>目标副本：{onlyOffice.session.name}</span>
          <span>会话有效期至 {new Date(onlyOffice.session.expiresAt).toLocaleTimeString()}</span>
        </div>
        {onlyOffice.error && <p className="office-editor-error" role="alert">{onlyOffice.error}</p>}
      </section>
    );
  }

  if (editor.busy && !editor.session) return <Loading message="正在打开可视化编辑器…" />;
  if (!editor.session) return <ErrorState title="无法打开编辑器" message={editor.error || '文件没有可编辑内容。'} onRetry={() => void editor.load()} retryLabel="重新打开" />;
  const { session } = editor;
  const changeSection = (sectionId: string) => {
    editor.setActiveSectionId(sectionId);
    const section = session.sections.find((candidate) => candidate.id === sectionId);
    editor.setSelectedId(section?.nodes.find((node) => !node.readOnly)?.id || section?.nodes[0]?.id || '');
  };

  return (
    <section className={`office-editor-shell office-editor--${session.kind}`}>
      <header className="office-editor-header">
        <div><span className="office-format-badge">{KIND_LABEL[session.kind]}</span><h2>{session.name}</h2><p>点击画布里的内容直接修改，原文件始终保留。</p></div>
        <div className="office-editor-header-actions">
          <Button variant="ghost" aria-pressed={structureCollapsed} onClick={() => setStructureCollapsed((value) => !value)}>{structureCollapsed ? '展开结构' : '收起结构'}</Button>
          <Button variant="ghost" aria-pressed={inspectorCollapsed} onClick={() => setInspectorCollapsed((value) => !value)}>{inspectorCollapsed ? '展开属性' : '收起属性'}</Button>
          {supportsOnlyOffice(item.name) && onlyOffice.status.enabled && (
            <Button
              variant="primary"
              disabled={onlyOffice.busy || !onlyOffice.status.configured || !onlyOffice.status.healthy || !copyName.trim()}
              onClick={() => void onlyOffice.open(copyName)}
            >
              {onlyOffice.busy ? '正在连接…' : onlyOffice.status.healthy ? '全功能编辑' : 'Document Server 不可用'}
            </Button>
          )}
          <Button variant="secondary" onClick={onClose}>退出编辑</Button>
        </div>
      </header>
      <div className={`office-editor-layout${session.kind === 'html' ? ' office-editor-layout--html' : ''}${structureCollapsed ? ' is-structure-collapsed' : ''}${inspectorCollapsed ? ' is-inspector-collapsed' : ''}`}>
        {!structureCollapsed && (session.kind === 'html' ? (
          <WebComponentTree nodes={webTree} selectedId={webSelection?.id || ''} onSelect={(targetId) => sendWebCommand({ type: 'select', targetId })} />
        ) : (
          <nav className="office-section-nav" aria-label="文档分区">
            <strong>{session.kind === 'xlsx' ? '工作表' : session.kind === 'pptx' ? '幻灯片' : '内容'}</strong>
            {session.sections.map((section) => (
              <button key={section.id} type="button" className={editor.activeSectionId === section.id ? 'is-active' : ''} onClick={() => changeSection(section.id)}>
                {section.label}<span>{section.nodes.length}</span>
              </button>
            ))}
            <div className="office-editor-safety"><span>副本模式</span><p>不会覆盖原文件</p></div>
          </nav>
        ))}
        <main className="office-canvas-wrap">
          <div className="office-canvas-toolbar"><span>{editor.changes.length ? `${editor.changes.length} 处修改未保存` : '点击内容开始编辑'}</span><Button size="sm" variant="ghost" disabled={!editor.canUndo} onClick={() => session.kind === 'html' ? sendWebCommand({ type: 'undo' }) : editor.undo()}>撤销</Button></div>
          {session.kind === 'html' ? (
            <WebPageCanvas
              source={session.htmlSource || ''}
              command={webCommand}
              onSelection={setWebSelection}
              onTree={setWebTree}
              onSnapshot={editor.updateHtml}
            />
          ) : (
            <OfficeFormatCanvas
              session={session}
              activeSectionId={editor.activeSectionId}
              selectedId={editor.selectedId}
              drafts={editor.draft.drafts}
              onSelect={editor.setSelectedId}
            />
          )}
        </main>
        {!inspectorCollapsed && <aside className="office-inspector">
          <div><span className="office-inspector-eyebrow">当前选择</span><h3>{session.kind === 'html' ? (webSelection ? `<${webSelection.tag}>` : '点击网页组件') : selected?.address || selected?.type || '点击内容'}</h3></div>
          {session.kind === 'html' && webSelection && (
            <WebEditorInspector
              key={webSelection.id}
              selection={webSelection}
              onUpdate={(patch) => sendWebCommand({ type: 'update', patch })}
              onAction={(action) => sendWebCommand({ type: 'action', action })}
              onInsert={(preset, placement) => sendWebCommand({ type: 'insert', preset, placement })}
            />
          )}
          {session.kind === 'html' && !webSelection && <p className="web-inspector-empty">从左侧结构或中间画布选择一个组件，即可修改内容、布局和样式。</p>}
          {session.kind !== 'html' && selected && (
            <label className="office-text-editor">内容
              <textarea
                disabled={selected.readOnly}
                value={editor.draft.drafts[selected.id] ?? selected.text}
                onChange={(event) => editor.updateNode(selected.id, event.target.value)}
              />
              {selected.readOnly && <small>公式单元格为只读，避免意外破坏计算逻辑。</small>}
            </label>
          )}
          <div className="office-save-card">
            <Input label="副本名称" value={copyName} onChange={(event) => setCopyName(event.target.value)} />
            <Button variant="primary" disabled={editor.busy || editor.changes.length === 0 || !copyName.trim()} onClick={() => void editor.save(copyName)}>
              {editor.busy ? '保存中…' : '保存为副本'}
            </Button>
            <small>保存后会作为新成果出现。</small>
          </div>
          {editor.error && <p className="office-editor-error" role="alert">{editor.error}</p>}
          {onlyOffice.error && <p className="office-editor-error" role="alert">{onlyOffice.error}</p>}
        </aside>}
      </div>
    </section>
  );
}
