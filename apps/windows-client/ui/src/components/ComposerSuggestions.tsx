import { ListboxOptionButton } from './ui/MenuItemButton';

export type ComposerSuggestionMode = 'template' | 'mention' | 'history';

export interface ComposerSuggestionItem {
  key: string;
  title: string;
  detail?: string;
  apply: () => void;
}

interface ComposerSuggestionsProps {
  mode: ComposerSuggestionMode;
  items: ComposerSuggestionItem[];
  active: number;
}

function titleForMode(mode: ComposerSuggestionMode): string {
  if (mode === 'template') return '命令 / 任务模板';
  if (mode === 'history') return '历史任务';
  return '引用本地文件';
}

export function ComposerSuggestions({ mode, items, active }: ComposerSuggestionsProps) {
  return (
    <div className="composer-popover" role="listbox">
      <div className="popover-header">{titleForMode(mode)}</div>
      {items.map((item, index) => (
        <ListboxOptionButton
          key={item.key}
          className="popover-item"
          active={index === active}
          onMouseDown={(event) => { event.preventDefault(); item.apply(); }}
        >
          <strong>{item.title}</strong>
          {item.detail && <span>{item.detail}</span>}
        </ListboxOptionButton>
      ))}
    </div>
  );
}
