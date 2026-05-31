// ComposerTriggers(UI · components):输入框触发按钮组——快捷插入模板/提及/历史触发符,提示可用的智能输入入口。纯展示+回调。
import { ICONS } from '../lib/icons';
import { Button } from './ui/Button';

export type ComposerTriggerChar = '/' | '@' | '#';

interface ComposerTriggersProps {
  onTrigger: (char: ComposerTriggerChar) => void;
}

// Visual replacement for the cryptic /-@-# slash hints in the textarea
// placeholder. Each button just delegates to a parent `insertTrigger` that knows
// how to splice the char into the current value + caret + refocus the textarea.
export function ComposerTriggers({ onTrigger }: ComposerTriggersProps) {
  return (
    <div className="composer-triggers" role="group" aria-label="快捷插入">
      <Button
        variant="secondary"
        className="composer-trigger-btn"
        onClick={() => onTrigger('/')}
        title="插入「/」从模板或命令里挑一个"
      >
        {`${ICONS.TEMPLATE} 模板`}
      </Button>
      <Button
        variant="secondary"
        className="composer-trigger-btn"
        onClick={() => onTrigger('@')}
        title="插入「@」搜索并引用工作区里的文件"
      >
        {`${ICONS.PAPERCLIP} 引用文件`}
      </Button>
      <Button
        variant="secondary"
        className="composer-trigger-btn"
        onClick={() => onTrigger('#')}
        title="插入「#」翻最近的对话"
      >
        {`${ICONS.HISTORY} 历史`}
      </Button>
    </div>
  );
}
