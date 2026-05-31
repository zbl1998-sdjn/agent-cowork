// MessageBubble(UI · components):单条消息气泡——按角色(用户/助手)渲染外框、头像/操作、承载消息正文与子卡片。纯展示+回调。
import type { ReactNode } from 'react';
import type { MessageRole } from '../lib/types';

export interface MessageBubbleProps {
  role: MessageRole;
  runId?: string;
  status?: string;
  time?: string;
  children?: ReactNode;
}

const NAME: Record<MessageRole, string> = { user: 'Derrick', assistant: 'Kimi' };

export function MessageBubble({ role, status, time, children }: MessageBubbleProps) {
  return (
    <div className={`bubble bubble-${role}`}>
      <div className="bubble-head">
        <span className={`bubble-avatar avatar-${role}`}>{role === 'user' ? 'D' : 'K'}</span>
        <span className="bubble-name">{NAME[role]}</span>
        {time && <span className="bubble-time">{time}</span>}
        {status && <span className="bubble-status">{status}</span>}
      </div>
      <div className="bubble-body">{children}</div>
    </div>
  );
}
