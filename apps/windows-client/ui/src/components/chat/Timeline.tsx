import type { RefObject } from 'react';
import { respondApprovals } from '../../lib/api';
import type { AssistantMessage, Message } from '../../lib/app-types';
import { AssistantTurn, UserEditTurn, UserTurn } from './TimelineTurns';

export {
  assistantTurnPropsEqual,
  userEditTurnPropsEqual,
  userTurnPropsEqual,
  type AssistantTurnProps,
  type UserEditTurnProps,
  type UserTurnProps,
} from './TimelineTurns';

interface TimelineProps {
  editText: string;
  editingMsgId: string | null;
  empty: boolean;
  hasNewContent: boolean;
  isAtBottom: boolean;
  messages: Message[];
  starters: string[];
  streamingId: string | null;
  timelineRef: RefObject<HTMLElement>;
  trustedRoot: string;
  onBeginEdit: (messageId: string, text: string) => void;
  onCopyText: (text: string) => void;
  onHandleApprove: (message: AssistantMessage) => void;
  onOpenOrPreview: (path: string) => void;
  onPatchAssistant: (id: string, patch: (message: AssistantMessage) => AssistantMessage) => void;
  onQuickSend: (text: string) => void;
  onRegenerate: (assistantId: string) => void;
  onScrollToBottom: () => void;
  onSetEditingMsgId: (id: string | null) => void;
  onSetEditText: (text: string) => void;
  onSubmitEdit: (messageId: string) => void;
}

interface PendingApprovalRef {
  messageId: string;
  id: string;
}

export function Timeline({
  editText,
  editingMsgId,
  empty,
  hasNewContent,
  isAtBottom,
  messages,
  starters,
  streamingId,
  timelineRef,
  trustedRoot,
  onBeginEdit,
  onCopyText,
  onHandleApprove,
  onOpenOrPreview,
  onPatchAssistant,
  onQuickSend,
  onRegenerate,
  onScrollToBottom,
  onSetEditingMsgId,
  onSetEditText,
  onSubmitEdit,
}: TimelineProps) {
  const pendingApprovalIds = new Set<string>();
  const pendingApprovals = messages.flatMap((message): PendingApprovalRef[] => {
    if (message.role !== 'assistant' || !message.approval) return [];
    const id = message.approval.id.trim();
    if (!id || pendingApprovalIds.has(id)) return [];
    pendingApprovalIds.add(id);
    return [{ messageId: message.id, id }];
  });
  return (
    <>
      <main className="timeline" role="log" ref={timelineRef}>
        {empty && (
          <div className="empty-state">
            <strong>Agent Cowork</strong>
            <p>直接和 Kimi 对话即可，它能读写工作区文件、运行代码。需要文件操作时会先请你批准。</p>
            <div className="starter-chips">
              {starters.map((sug) => <button key={sug} type="button" className="starter-chip" onClick={() => onQuickSend(sug)}>{sug}</button>)}
            </div>
          </div>
        )}
        {pendingApprovals.length > 1 && <BatchApprovalBar pendingApprovals={pendingApprovals} onPatchAssistant={onPatchAssistant} />}
        {messages.map((message) => message.role === 'user' ? (
          editingMsgId === message.id ? (
            <UserEditTurn
              key={message.id}
              editText={editText}
              message={message}
              onSetEditingMsgId={onSetEditingMsgId}
              onSetEditText={onSetEditText}
              onSubmitEdit={onSubmitEdit}
            />
          ) : (
            <UserTurn key={message.id} message={message} streamingId={streamingId} onBeginEdit={onBeginEdit} />
          )
        ) : (
          <AssistantTurn
            key={message.id}
            message={message}
            streamingId={streamingId}
            trustedRoot={trustedRoot}
            onCopyText={onCopyText}
            onHandleApprove={onHandleApprove}
            onOpenOrPreview={onOpenOrPreview}
            onPatchAssistant={onPatchAssistant}
            onQuickSend={onQuickSend}
            onRegenerate={onRegenerate}
          />
        ))}
      </main>
      {hasNewContent && !isAtBottom && (
        <button type="button" className="jump-to-bottom" onClick={() => onScrollToBottom()} title="回到底部">回到底部 ↓</button>
      )}
    </>
  );
}

function BatchApprovalBar({ pendingApprovals, onPatchAssistant }: { pendingApprovals: PendingApprovalRef[]; onPatchAssistant: TimelineProps['onPatchAssistant'] }) {
  const respondToBatch = (decision: 'once' | 'session') => {
    const ids = pendingApprovals.map((item) => item.id);
    void respondApprovals(ids, decision);
    pendingApprovals.forEach((item) => onPatchAssistant(item.messageId, (m) => ({ ...m, approval: undefined })));
  };
  return <div className="approval-bar"><span className="approval-q">待批准操作：<strong>{pendingApprovals.length}</strong> 个</span><div className="approval-actions"><button type="button" onClick={() => respondToBatch('once')}>批准当前 {pendingApprovals.length} 个</button><button type="button" onClick={() => respondToBatch('session')}>本会话批准当前 {pendingApprovals.length} 个</button></div></div>;
}
