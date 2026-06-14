// ComposerTriggers(UI · components):输入框触发按钮组——快捷插入模板/提及/历史触发符,提示可用的智能输入入口。纯展示+回调。
import { ICONS } from '../lib/icons';
import { Button } from './ui/Button';

export type ComposerTriggerChar = '/' | '@' | '#';

interface ComposerTriggersProps {
  onTrigger: (char: ComposerTriggerChar) => void;
}

// 用可视按钮替代输入框 placeholder 里晦涩的 /-@-# 提示。
// 每个按钮只把触发符委托给父级 `insertTrigger`,由其负责将字符插入
// 当前值 + 光标位置并重新聚焦输入框。
export function ComposerTriggers({ onTrigger }: ComposerTriggersProps) {
  return (
    <div className="composer-triggers" role="group" aria-label="快捷插入">
      <Button
        variant="secondary"
        className="composer-trigger-btn"
        onMouseDown={(e) => { e.preventDefault(); onTrigger('/'); }}
        title="插入「/」从模板或命令里挑一个"
      >
        {`${ICONS.TEMPLATE} 模板`}
      </Button>
      <Button
        variant="secondary"
        className="composer-trigger-btn"
        onMouseDown={(e) => { e.preventDefault(); onTrigger('@'); }}
        title="插入「@」搜索并引用工作区里的文件"
      >
        {`${ICONS.PAPERCLIP} 引用文件`}
      </Button>
      <Button
        variant="secondary"
        className="composer-trigger-btn"
        onMouseDown={(e) => { e.preventDefault(); onTrigger('#'); }}
        title="插入「#」翻最近的对话"
      >
        {`${ICONS.HISTORY} 历史`}
      </Button>
    </div>
  );
}
