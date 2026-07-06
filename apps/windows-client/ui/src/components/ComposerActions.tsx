// ComposerActions(UI · components):输入框动作区——发送按钮与工具开关(上传/语音/优化)。
// 对标 Claude 底部:工具用线性图标(tooltip),不用文字堆叠。纯展示+回调。
import { Button } from './ui/Button';
import { Icon } from './ui/Icon';

// 发送按钮基准色(供对比度单测引用);实际样式走 styles 的 .ui-btn--primary / .composer .send-button。
export const SEND_BUTTON_BACKGROUND = '#b5482f';

export function ComposerToolActions({
  listening,
  refining,
  canRefine,
  onUpload,
  onToggleVoice,
  onRefine,
}: {
  listening: boolean;
  refining: boolean;
  canRefine: boolean;
  onUpload: () => void;
  onToggleVoice: () => void;
  onRefine: () => void;
}) {
  return (
    <>
      <Button className="tool-button tool-icon-btn" title="上传文件" aria-label="上传文件" onClick={onUpload}>
        <Icon name="paperclip" size={17} />
      </Button>
      <Button className={`tool-button tool-icon-btn${listening ? ' is-active' : ''}`} title="语音输入" aria-label="语音输入" onClick={onToggleVoice}>
        <Icon name="mic" size={17} />
      </Button>
      <Button className="tool-button tool-icon-btn" title="优化提示" aria-label="优化提示" disabled={!canRefine || refining} onClick={onRefine}>
        {refining ? <span className="tool-refining">…</span> : <Icon name="sparkle" size={17} />}
      </Button>
    </>
  );
}

export function ComposerSendAction({ refining, onSend }: { refining: boolean; onSend: () => void }) {
  return (
    <Button variant="primary" className="send-button" disabled={refining} onClick={onSend}>
      发送
    </Button>
  );
}
