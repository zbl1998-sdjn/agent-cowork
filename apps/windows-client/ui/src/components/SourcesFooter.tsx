import { useState } from 'react';
import type { SourceRef } from '../lib/types';

export interface SourcesFooterProps {
  sources: SourceRef[];
}

export function SourcesFooter({ sources }: SourcesFooterProps) {
  const [open, setOpen] = useState(false);
  if (!sources.length) return null;
  return (
    <div className="sources-footer">
      <button type="button" className="sources-toggle" onClick={() => setOpen((v) => !v)}>
        来源 ({sources.length})
      </button>
      {open && (
        <ul>
          {sources.map((source, index) => (
            <li key={index}>
              <code>{source.relativePath || source.path}</code>
              {source.excerpt && <span>{source.excerpt}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
