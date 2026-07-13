import type { CSSProperties } from 'react';

import type { WebComponentNode } from '../../lib/types/webEditor';

function nodeStyle(depth: number): CSSProperties {
  return { paddingInlineStart: `${10 + Math.min(depth, 8) * 14}px` };
}

export function WebComponentTree({
  nodes,
  selectedId,
  onSelect,
}: {
  nodes: WebComponentNode[];
  selectedId?: string;
  onSelect: (id: string) => void;
}) {
  return (
    <nav className="web-component-tree" aria-label="页面结构">
      <header><strong>页面结构</strong><span>{nodes.length} 个组件</span></header>
      {nodes.length ? (
        <ul role="tree">
          {nodes.map((node) => (
            <li key={node.id} role="none">
              <button
                type="button"
                role="treeitem"
                aria-level={node.depth + 1}
                aria-current={selectedId === node.id ? 'true' : undefined}
                className={selectedId === node.id ? 'is-active' : ''}
                style={nodeStyle(node.depth)}
                onClick={() => onSelect(node.id)}
              >
                <code>{node.tag}</code>
                <span>{node.label}</span>
                {node.childCount > 0 && <small>{node.childCount}</small>}
              </button>
            </li>
          ))}
        </ul>
      ) : <p>页面中还没有可编辑组件。</p>}
      <footer>点击结构或画布都能选择组件</footer>
    </nav>
  );
}
