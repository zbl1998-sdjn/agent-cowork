// Office 格式画布(UI · 组件层 · components/office)
// ---------------------------------------------------------------------------
// 职责:把统一会话节点按 Word 纸张、Excel 网格、PPT 幻灯片三种熟悉隐喻渲染为可点选对象。
import type { OfficeEditorNode, OfficeEditorSession } from '../../lib/api';

function nodeText(node: OfficeEditorNode, drafts: Record<string, string>): string {
  return Object.hasOwn(drafts, node.id) ? drafts[node.id] ?? '' : node.text;
}

function columnNumber(address: string): number {
  const letters = address.replace(/\d/g, '');
  return [...letters].reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0);
}

function SheetCanvas({ nodes, drafts, selectedId, onSelect }: CanvasProps & { nodes: OfficeEditorNode[] }) {
  const cells = new Map(nodes.map((node) => [node.address || '', node]));
  const maxRow = Math.min(100, Math.max(1, ...nodes.map((node) => Number.parseInt(node.address?.match(/\d+/)?.[0] || '1', 10))));
  const maxColumn = Math.min(26, Math.max(1, ...nodes.map((node) => columnNumber(node.address || 'A1'))));
  return (
    <div className="office-sheet-grid" style={{ gridTemplateColumns: `46px repeat(${maxColumn}, minmax(110px, 1fr))` }}>
      <span className="office-sheet-corner" />
      {Array.from({ length: maxColumn }, (_, index) => <strong key={`column-${index}`}>{String.fromCharCode(65 + index)}</strong>)}
      {Array.from({ length: maxRow }, (_, rowIndex) => {
        const row = rowIndex + 1;
        return [<strong key={`row-${row}`}>{row}</strong>, ...Array.from({ length: maxColumn }, (_unused, columnIndex) => {
          const address = `${String.fromCharCode(65 + columnIndex)}${row}`;
          const node = cells.get(address);
          return node ? (
            <button key={address} type="button" className={`${selectedId === node.id ? 'is-selected ' : ''}${node.readOnly ? 'is-readonly' : ''}`} onClick={() => onSelect(node.id)}>
              {nodeText(node, drafts) || '\u00a0'}
            </button>
          ) : <span key={address} className="office-sheet-empty" />;
        })];
      })}
    </div>
  );
}

type CanvasProps = {
  session: OfficeEditorSession;
  activeSectionId: string;
  selectedId: string;
  drafts: Record<string, string>;
  onSelect: (id: string) => void;
};

export function OfficeFormatCanvas(props: CanvasProps) {
  const section = props.session.sections.find((candidate) => candidate.id === props.activeSectionId) || props.session.sections[0];
  const nodes = section?.nodes || [];
  if (props.session.kind === 'xlsx') return <SheetCanvas {...props} nodes={nodes} />;
  if (props.session.kind === 'pptx') {
    return (
      <div className="office-slide-canvas">
        {nodes.map((node, index) => (
          <button key={node.id} type="button" className={props.selectedId === node.id ? 'is-selected' : ''} data-shape={index} onClick={() => props.onSelect(node.id)}>
            {nodeText(node, props.drafts)}
          </button>
        ))}
      </div>
    );
  }
  return (
    <article className="office-document-page">
      {nodes.map((node, index) => (
        <button key={node.id} type="button" className={props.selectedId === node.id ? 'is-selected' : ''} data-paragraph={index} onClick={() => props.onSelect(node.id)}>
          {nodeText(node, props.drafts) || '\u00a0'}
        </button>
      ))}
    </article>
  );
}
