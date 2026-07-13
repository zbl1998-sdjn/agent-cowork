import { useEffect, useMemo, useState } from 'react';
import { buildArtifactRevisionPrompt, parseArtifactBlocks, replaceArtifactBlock, type ArtifactBlock } from '../lib/artifact-canvas';
import { Button } from './ui/Button';
import { Icon } from './ui/Icon';

interface ArtifactCanvasProps {
  artifactId: string | null;
  text: string;
  streaming: boolean;
  onApplyText: (text: string) => void;
  onRequestRevision: (prompt: string) => void;
  onCollapse?: (() => void) | undefined;
}

function ArtifactBlockContent({ block }: { block: ArtifactBlock }) {
  if (block.kind === 'heading') return <strong>{block.text.replace(/^#{1,6}\s*/, '')}</strong>;
  if (block.kind === 'code') return <pre>{block.text.replace(/^```[^\n]*\n?/, '').replace(/\n?```$/, '')}</pre>;
  if (block.kind === 'list') return <span>{block.text.split('\n').map((line, index) => <span className="artifact-list-line" key={`${block.id}-${index}`}>{line}</span>)}</span>;
  return <span>{block.text}</span>;
}

export function ArtifactCanvas({ artifactId, text, streaming, onApplyText, onRequestRevision, onCollapse }: ArtifactCanvasProps) {
  const blocks = useMemo(() => parseArtifactBlocks(text), [text]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [instruction, setInstruction] = useState('');
  const [annotation, setAnnotation] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [showBefore, setShowBefore] = useState(false);
  const selected = blocks.find((block) => block.id === selectedId) || null;
  const beforeText = history.at(-1) || '';

  useEffect(() => {
    setSelectedId(null);
    setEditText('');
    setInstruction('');
    setAnnotation('');
    setHistory([]);
    setShowBefore(false);
  }, [artifactId]);

  const selectBlock = (block: ArtifactBlock) => {
    setSelectedId(block.id);
    setEditText(block.text);
    setShowBefore(false);
  };

  const applyLocalEdit = () => {
    if (!selected || streaming || editText === selected.text) return;
    setHistory((items) => [...items, text]);
    onApplyText(replaceArtifactBlock(text, selected, editText));
  };

  const undo = () => {
    const previous = history.at(-1);
    if (!previous || streaming) return;
    setHistory((items) => items.slice(0, -1));
    setSelectedId(null);
    onApplyText(previous);
  };

  const requestRevision = () => {
    if (!selected || !instruction.trim() || streaming) return;
    onRequestRevision(buildArtifactRevisionPrompt(selected, instruction, annotation));
    setInstruction('');
  };

  return (
    <section className={`artifact-canvas${streaming ? ' is-streaming' : ''}`} aria-label="成果画布">
      <header className="artifact-canvas-head">
        <div>
          <span className="artifact-eyebrow"><Icon name="sparkle" size={13} /> 成果画布</span>
          <strong>{artifactId ? '可直接点选修改' : '等待第一个成果'}</strong>
        </div>
        <div className="artifact-canvas-actions">
          {streaming && <span className="artifact-live"><i className="artifact-live-dot" />正在生成</span>}
          <button type="button" disabled={!history.length || streaming} onClick={undo}>撤销</button>
          <button type="button" disabled={!history.length} aria-pressed={showBefore} className={showBefore ? 'is-active' : ''} onClick={() => setShowBefore((value) => !value)}>前后对比</button>
          {onCollapse && <button type="button" aria-label="收起成果画布" onClick={onCollapse}>收起</button>}
        </div>
      </header>

      {!text.trim() ? (
        <div className="artifact-empty">
          <span><Icon name="artifacts" size={22} /></span>
          <strong>成果会在这里逐步出现</strong>
          <p>发送任务后，文档、方案和代码会边生成边显示。生成后点任意内容即可局部修改。</p>
        </div>
      ) : showBefore && beforeText ? (
        <div className="artifact-compare">
          <article><small>修改前</small><pre>{beforeText}</pre></article>
          <article><small>当前版本</small><pre>{text}</pre></article>
        </div>
      ) : (
        <div className="artifact-stage">
          <div className="artifact-paper">
            <div className="artifact-hint">点击内容即可局部修改</div>
            {blocks.map((block, index) => (
              <button key={block.id} type="button" disabled={streaming} aria-label={`选择成果块 ${index + 1}`} aria-pressed={selectedId === block.id} className={`artifact-block is-${block.kind}${selectedId === block.id ? ' is-selected' : ''}`} onClick={() => selectBlock(block)}>
                <ArtifactBlockContent block={block} />
              </button>
            ))}
            {streaming && <span className="artifact-stream-caret" aria-hidden="true" />}
          </div>
        </div>
      )}

      {selected && !showBefore && (
        <aside className="artifact-inspector" aria-label="局部编辑器">
          <div className="artifact-inspector-head"><span>已选中 · {selected.kind === 'heading' ? '标题' : selected.kind === 'list' ? '列表' : selected.kind === 'code' ? '代码' : '正文'}</span><button type="button" aria-label="关闭局部编辑器" onClick={() => setSelectedId(null)}>×</button></div>
          <label>直接修改<textarea value={editText} disabled={streaming} onChange={(event) => setEditText(event.target.value)} /></label>
          <Button size="sm" variant="secondary" disabled={streaming || editText === selected.text} onClick={applyLocalEdit}>应用到画布</Button>
          <div className="artifact-inspector-divider"><span>或让 AI 修改</span></div>
          <label>修改要求<textarea value={instruction} disabled={streaming} placeholder="例如：改得更简洁，并突出结论" onChange={(event) => setInstruction(event.target.value)} /></label>
          <label>批注（可选）<input value={annotation} disabled={streaming} placeholder="补充背景、负责人或限制" onChange={(event) => setAnnotation(event.target.value)} /></label>
          <Button size="sm" variant="primary" disabled={streaming || !instruction.trim()} onClick={requestRevision}>让 AI 修改此处</Button>
        </aside>
      )}
    </section>
  );
}
