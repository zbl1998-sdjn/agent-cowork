import { Button } from './ui/Button';

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
      <Button className="tool-button" title="上传文件" onClick={onUpload}>上传</Button>
      <Button className={`tool-button${listening ? ' is-active' : ''}`} title="语音输入" onClick={onToggleVoice}>语音</Button>
      <Button className="tool-button" title="优化提示" disabled={!canRefine || refining} onClick={onRefine}>
        {refining ? '优化中…' : '优化提示'}
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
