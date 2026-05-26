import { useCallback, useMemo, useState, type CSSProperties, type RefObject, type UIEvent } from 'react';
import { respondApprovals } from '../../lib/api';
import type { AssistantMessage, Message } from '../../lib/app-types';
import { computeVirtualWindow } from '../../hooks/useVirtualWindow';
import { Button } from '../ui/Button';
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

const TIMELINE_VIRTUALIZE_AFTER = 120;
const TIMELINE_ESTIMATED_ROW_HEIGHT = 132;
const TIMELINE_VIEWPORT_FALLBACK = 720;
const TIMELINE_OVERSCAN = 8;

const starterChipStyle: CSSProperties = {
  borderColor: 'var(--border)',
  background: '#fff',
  color: '#3a3e36',
  borderRadius: 14,
  padding: '8px 14px',
  fontSize: 13,
};

const jumpToBottomStyle: CSSProperties = {
  position: 'absolute',
  left: '50%',
  bottom: 118,
  transform: 'translateX(-50%)',
  zIndex: 24,
  minHeight: 34,
  borderColor: '#d7c9c0',
  background: 'rgba(255,255,255,0.94)',
  color: '#b5482f',
  borderRadius: 18,
  padding: '7px 14px',
  fontSize: 13,
  boxShadow: '0 10px 24px rgba(27, 28, 30, 0.12)',
};

interface TimelineScrollMetrics {
  scrollTop: number;
  viewportHeight: number;
}

export interface TimelineWindow {
  virtualized: boolean;
  startIndex: number;
  endIndex: number;
  topSpacer: number;
  bottomSpacer: number;
  messages: Message[];
}

export function computeTimelineWindow(messages: Message[], metrics: TimelineScrollMetrics, isAtBottom: boolean): TimelineWindow {
  if (messages.length <= TIMELINE_VIRTUALIZE_AFTER) {
    return { virtualized: false, startIndex: 0, endIndex: messages.length - 1, topSpacer: 0, bottomSpacer: 0, messages };
  }

  const viewportHeight = Math.max(1, metrics.viewportHeight || TIMELINE_VIEWPORT_FALLBACK);
  const totalHeight = messages.length * TIMELINE_ESTIMATED_ROW_HEIGHT;
  const scrollTop = isAtBottom ? Math.max(0, totalHeight - viewportHeight) : Math.max(0, metrics.scrollTop);
  const win = computeVirtualWindow({
    scrollTop,
    viewportHeight,
    itemHeight: TIMELINE_ESTIMATED_ROW_HEIGHT,
    count: messages.length,
    overscan: TIMELINE_OVERSCAN,
  });
  const renderedHeight = win.visibleCount * TIMELINE_ESTIMATED_ROW_HEIGHT;
  return {
    virtualized: true,
    startIndex: win.startIndex,
    endIndex: win.endIndex,
    topSpacer: win.offsetTop,
    bottomSpacer: Math.max(0, win.totalHeight - win.offsetTop - renderedHeight),
    messages: messages.slice(win.startIndex, win.endIndex + 1),
  };
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
  const [scrollMetrics, setScrollMetrics] = useState<TimelineScrollMetrics>({
    scrollTop: 0,
    viewportHeight: TIMELINE_VIEWPORT_FALLBACK,
  });
  const timelineWindow = useMemo(
    () => computeTimelineWindow(messages, scrollMetrics, isAtBottom),
    [messages, scrollMetrics, isAtBottom],
  );
  const onTimelineScroll = useCallback((event: UIEvent<HTMLElement>) => {
    const nextScrollTop = event.currentTarget.scrollTop;
    const nextViewportHeight = event.currentTarget.clientHeight || TIMELINE_VIEWPORT_FALLBACK;
    setScrollMetrics((current) => (
      current.scrollTop === nextScrollTop && current.viewportHeight === nextViewportHeight
        ? current
        : { scrollTop: nextScrollTop, viewportHeight: nextViewportHeight }
    ));
  }, []);
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
      <main className="timeline" role="log" ref={timelineRef} onScroll={onTimelineScroll}>
        {empty && (
          <div className="empty-state">
            <strong>Agent Cowork</strong>
            <p>直接和 Kimi 对话即可，它能读写工作区文件、运行代码。需要文件操作时会先请你批准。</p>
            <div className="starter-chips">
              {starters.map((sug) => <Button key={sug} className="starter-chip" onClick={() => onQuickSend(sug)} style={starterChipStyle}>{sug}</Button>)}
            </div>
          </div>
        )}
        {pendingApprovals.length > 1 && <BatchApprovalBar pendingApprovals={pendingApprovals} onPatchAssistant={onPatchAssistant} />}
        <div className="timeline-window" data-virtualized={timelineWindow.virtualized ? 'true' : undefined}>
          {timelineWindow.topSpacer > 0 && <div aria-hidden="true" className="timeline-window-spacer" style={{ height: timelineWindow.topSpacer }} />}
          {timelineWindow.messages.map((message) => message.role === 'user' ? (
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
          {timelineWindow.bottomSpacer > 0 && <div aria-hidden="true" className="timeline-window-spacer" style={{ height: timelineWindow.bottomSpacer }} />}
        </div>
      </main>
      {hasNewContent && !isAtBottom && (
        <Button className="jump-to-bottom" onClick={() => onScrollToBottom()} title="回到底部" style={jumpToBottomStyle}>回到底部 ↓</Button>
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
  return (
    <div className="approval-bar">
      <span className="approval-q">待批准操作：<strong>{pendingApprovals.length}</strong> 个</span>
      <div className="approval-actions">
        <Button variant="primary" onClick={() => respondToBatch('once')}>批准当前 {pendingApprovals.length} 个</Button>
        <Button variant="secondary" onClick={() => respondToBatch('session')}>本会话批准当前 {pendingApprovals.length} 个</Button>
      </div>
    </div>
  );
}
