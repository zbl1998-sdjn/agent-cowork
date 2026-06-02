// SourcesFooter(UI · components):来源脚注——在助手回答下展示引用来源(文件/检索块,路径+行号),可点开定位。纯展示+回调。
import { useState } from 'react';
import type { SourceRef } from '../lib/types';
import { Button } from './ui/Button';

export interface SourcesFooterProps {
  sources: SourceRef[];
}

export function SourcesFooter({ sources }: SourcesFooterProps) {
  const [open, setOpen] = useState(false);
  if (!sources.length) return null;
  return (
    <div className="sources-footer">
      <Button className="sources-toggle" size="sm" onClick={() => setOpen((v) => !v)}>
        来源 ({sources.length})
      </Button>
      {open && (
        <ul>
          {sources.map((source, index) => (
            <li key={index}>
              <code>{source.relativePath || source.path}</code>
              {source.startLine && (
                <small>
                  L{source.startLine}{source.endLine && source.endLine !== source.startLine ? `-L${source.endLine}` : ''}
                </small>
              )}
              {source.excerpt && <span>{source.excerpt}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
