// MessageBubble 消息气泡(UI · 组件层 · components)
// ---------------------------------------------------------------------------
// 职责:按角色(用户/助手)渲染气泡外框,显示头像、名字、时间、状态,并以 children 承载消息正文与子卡片。
// 依赖:lib/types(MessageRole)。关键 props:role、status、time、children。
import type { ReactNode } from 'react';
import type { MessageRole } from '../lib/types';

export interface MessageBubbleProps {
  role: MessageRole;
  runId?: string | undefined;
  status?: string | undefined;
  time?: string | undefined;
  children?: ReactNode | undefined;
}

const NAME: Record<MessageRole, string> = { user: '用户', assistant: 'Agent' };

export function MessageBubble({ role, status, time, children }: MessageBubbleProps) {
  return (
    <div className={`bubble bubble-${role}`}>
      <div className="bubble-head">
        <span className={`bubble-avatar avatar-${role}`}>{role === 'user' ? 'U' : 'A'}</span>
        <span className="bubble-name">{NAME[role]}</span>
        {time && <span className="bubble-time">{time}</span>}
        {status && <span className="bubble-status">{status}</span>}
      </div>
      <div className="bubble-body">{children}</div>
    </div>
  );
}
