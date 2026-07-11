// Timeline(UI · components/chat):聊天主时间线容器——渲染消息/事件流、驱动滚动粘底与虚拟化,按回合分组。纯展示+回调。
import { useCallback, useMemo, useState, type CSSProperties, type Ref, type UIEvent } from 'react';
import { usePendingAction } from '../../hooks/usePendingAction';
import { respondApprovals } from '../../lib/api';
import type { AssistantMessage, Message } from '../../lib/app-types';
import {
  clearAcknowledgedAssistantRequest,
  partitionApprovalAcknowledgements,
  setPendingApprovalError,
  type PendingApprovalRef,
} from '../../lib/pending-action';
import { computeVirtualWindow } from '../../hooks/useVirtualWindow';
import { Button } from '../ui/Button';
import { AssistantTurn, UserEditTurn, UserTurn } from './TimelineTurns';
import { BeginnerHome } from '../BeginnerHome';

export {
  assistantTurnPropsEqual,
  assistantContinueRunId,
  userEditTurnPropsEqual,
  userTurnPropsEqual,
  type AssistantTurnProps,
  type UserEditTurnProps,
  type UserTurnProps,
} from './TimelineTurns';
export { partitionApprovalAcknowledgements } from '../../lib/pending-action';
interface TimelineProps {
  editText: string;
  editingMsgId: string | null;
  empty: boolean;
  hasNewContent: boolean;
  isAtBottom: boolean;
  messages: Message[];
  starters: string[];
  streamingId: string | null;
  timelineRef: Ref<HTMLElement>;
  trustedRoot: string;
  onBeginEdit: (messageId: string, text: string) => void;
  onCopyText: (text: string) => void;
  onHandleApprove: (message: AssistantMessage) => void;
  onOpenOrPreview: (path: string) => void;
  onPatchAssistant: (id: string, patch: (message: AssistantMessage) => AssistantMessage) => void;
  onQuickSend: (text: string) => void;
  onCaptureRecipe: (assistantId: string, runId: string) => void;
  onRegenerate: (assistantId: string) => void;
  onResumeRun: (runId: string) => void;
  onScrollToBottom: () => void;
  onSetEditingMsgId: (id: string | null) => void;
  onSetEditText: (text: string) => void;
  onSubmitEdit: (messageId: string) => void;
}

const TIMELINE_VIRTUALIZE_AFTER = 120;
const TIMELINE_ESTIMATED_ROW_HEIGHT = 132;
const TIMELINE_VIEWPORT_FALLBACK = 720;
const TIMELINE_OVERSCAN = 8;

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
  onCaptureRecipe,
  onRegenerate,
  onResumeRun,
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
    return [{ messageId: message.id, id, sessionReusable: message.approval.sessionReusable === true }];
  });
  return (
    <>
      <main
        className="timeline"
        role="log"
        aria-label="对话时间线"
        aria-live="polite"
        aria-relevant="additions text"
        ref={timelineRef}
        onScroll={onTimelineScroll}
      >
        {empty && <BeginnerHome starters={starters} onQuickSend={onQuickSend} />}
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
              onCaptureRecipe={onCaptureRecipe}
              onRegenerate={onRegenerate}
              onResumeRun={onResumeRun}
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
  const { pending, error, run } = usePendingAction('提交批量审批决定');
  const respondToBatch = (decision: 'once' | 'session') => {
    const ids = pendingApprovals.map((item) => item.id);
    void run(async () => {
      const result = await respondApprovals(ids, decision);
      const partitioned = partitionApprovalAcknowledgements(pendingApprovals, result);
      partitioned.acknowledged.forEach((item) => onPatchAssistant(
        item.messageId,
        (m) => clearAcknowledgedAssistantRequest(m, 'approval', item.id),
      ));
      if (partitioned.failed.length > 0) {
        const failure = `本地服务未确认 ${partitioned.failed.length} 个审批，失败项已保留，请重试`;
        partitioned.failed.forEach((item) => onPatchAssistant(
          item.messageId,
          (m) => setPendingApprovalError(m, item.id, failure),
        ));
        throw new Error(failure);
      }
    });
  };
  return (
    <div className="approval-bar">
      <span className="approval-q">待批准操作：<strong>{pendingApprovals.length}</strong> 个</span>
      <div className="approval-actions">
        <Button variant="primary" disabled={pending} onClick={() => respondToBatch('once')}>{pending ? '提交中…' : `批准当前 ${pendingApprovals.length} 个`}</Button>
        {pendingApprovals.every((item) => item.sessionReusable) && <Button variant="secondary" disabled={pending} onClick={() => respondToBatch('session')}>本会话批准当前 {pendingApprovals.length} 个</Button>}
      </div>
      {error && <div className="panel-error" role="alert">{error}</div>}
    </div>
  );
}
