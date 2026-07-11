// ComposerTriggers(UI · components):输入框快捷插入组——模板(/)、引用文件(@)、历史(#)。
// 对标 Claude:纯线性图标 + tooltip,不堆文字。纯展示+回调。
import { Button } from './ui/Button';
import { Icon } from './ui/Icon';
import type { ComposerTriggerChar } from '../lib/types/composer';

export type { ComposerTriggerChar } from '../lib/types/composer';

interface ComposerTriggersProps {
  onTrigger: (char: ComposerTriggerChar) => void;
}

export function ComposerTriggers({ onTrigger }: ComposerTriggersProps) {
  return (
    <div className="composer-triggers" role="group" aria-label="快捷插入">
      <Button
        variant="secondary"
        className="composer-trigger-btn"
        aria-label="从模板或命令挑一个"
        onMouseDown={(e) => { e.preventDefault(); onTrigger('/'); }}
        title="插入「/」从模板或命令里挑一个"
      >
        <Icon name="template" size={16} />
      </Button>
      <Button
        variant="secondary"
        className="composer-trigger-btn"
        aria-label="引用工作区文件"
        onMouseDown={(e) => { e.preventDefault(); onTrigger('@'); }}
        title="插入「@」搜索并引用工作区里的文件"
      >
        <Icon name="search" size={16} />
      </Button>
      <Button
        variant="secondary"
        className="composer-trigger-btn"
        aria-label="翻最近对话"
        onMouseDown={(e) => { e.preventDefault(); onTrigger('#'); }}
        title="插入「#」翻最近的对话"
      >
        <Icon name="history" size={16} />
      </Button>
    </div>
  );
}
