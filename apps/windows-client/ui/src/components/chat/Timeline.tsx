import type { RefObject } from 'react';
import { answerQuestion, openPath, respondApproval } from '../../lib/api';
import { extractSuggestions } from '../../lib/md';
import type { AssistantMessage, Message } from '../../lib/app-types';
import { MessageText } from '../MessageText';
import { MessageBubble } from '../MessageBubble';
import { ProgressLine } from '../ProgressLine';
import { PreviewCard } from '../PreviewCard';
import { ApprovalActions } from '../ApprovalActions';
import { SourcesFooter } from '../SourcesFooter';
import { ArtifactCard } from '../ArtifactCard';
import { TaskStatusBadge } from '../TaskStatusBadge';
import { ToolCallCard } from '../ToolCallCard';
import { MessageActions } from '../MessageActions';
import { TodoList } from '../TodoList';

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
        {messages.map((message) => message.role === 'user' ? (
          editingMsgId === message.id ? (
            <div key={message.id} className="user-edit">
              <textarea
                className="user-edit-area"
                value={editText}
                autoFocus
                onChange={(e) => onSetEditText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onSubmitEdit(message.id); }
                  else if (e.key === 'Escape') onSetEditingMsgId(null);
                }}
              />
              <div className="user-edit-actions">
                <button type="button" className="btn-secondary" onClick={() => onSetEditingMsgId(null)}>取消</button>
                <button type="button" className="btn-primary" onClick={() => onSubmitEdit(message.id)}>重新发送</button>
              </div>
            </div>
          ) : (
            <MessageBubble key={message.id} role="user">
              <span className="user-msg-text">{message.text}</span>
              {!streamingId && <button type="button" className="user-edit-btn" title="编辑并重新发送" onClick={() => onBeginEdit(message.id, message.text)}>✎ 编辑</button>}
            </MessageBubble>
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

interface AssistantTurnProps {
  message: AssistantMessage;
  streamingId: string | null;
  trustedRoot: string;
  onCopyText: (text: string) => void;
  onHandleApprove: (message: AssistantMessage) => void;
  onOpenOrPreview: (path: string) => void;
  onPatchAssistant: (id: string, patch: (message: AssistantMessage) => AssistantMessage) => void;
  onQuickSend: (text: string) => void;
  onRegenerate: (assistantId: string) => void;
}

function AssistantTurn({ message, streamingId, trustedRoot, onCopyText, onHandleApprove, onOpenOrPreview, onPatchAssistant, onQuickSend, onRegenerate }: AssistantTurnProps) {
  return (
    <MessageBubble role="assistant" status="" runId={message.runId}>
      {(message.status === 'thinking' || message.status === 'streaming') && !message.text && <div className="turn-status">{message.reasoning ? '思考中' : '正在响应'}<span className="typing-dots" aria-hidden="true"><i /><i /><i /></span></div>}
      {message.reasoning && <details className="reasoning" open={!message.text}><summary>思考过程</summary><div className="reasoning-body">{message.reasoning}</div></details>}
      {message.todos && message.todos.length > 0 && <TodoList items={message.todos} />}
      {message.progress.map((p, i) => <ProgressLine key={i} {...p} />)}
      {message.tools && message.tools.length > 0 && <div className="toolcalls">{message.tools.map((t, i) => <ToolCallCard key={i} call={t} />)}</div>}
      {message.plan && <PlanCard message={message} trustedRoot={trustedRoot} onPatchAssistant={onPatchAssistant} />}
      {message.question && <QuestionCard message={message} onPatchAssistant={onPatchAssistant} />}
      {message.approval && <ApprovalBar message={message} onPatchAssistant={onPatchAssistant} />}
      {message.text && <AssistantText message={message} streamingId={streamingId} trustedRoot={trustedRoot} onQuickSend={onQuickSend} />}
      {message.files && message.files.length > 0 && <div className="file-cards">{message.files.map((fp, i) => <ArtifactCard key={`${fp}-${i}`} file={{ path: `${trustedRoot}/${fp}`, relativePath: fp }} metadata={fp} onOpen={onOpenOrPreview} />)}</div>}
      {message.operations.length > 0 && <PreviewCard operations={message.operations} />}
      {message.operations.length > 0 && <ApprovalActions runId={message.runId || ''} operations={message.operations} approvalState={message.approvalState} onApprove={() => onHandleApprove(message)} onReject={() => onPatchAssistant(message.id, (m) => ({ ...m, approvalState: 'rejected' }))} />}
      <SourcesFooter sources={message.sources} />
      {message.status === 'done' && message.text && <MessageActions onCopy={() => onCopyText(extractSuggestions(message.text || '').text)} onRegenerate={() => onRegenerate(message.id)} />}
      {message.usage && message.usage.total_tokens ? <div className="usage-line">用量 {message.usage.total_tokens} tokens</div> : null}
      {message.operations.length > 0 && <TaskStatusBadge runId={message.runId} status={message.status} />}
      {message.approvalState === 'approved' && <ArtifactCard file={{ path: `${trustedRoot}/.AgentCowork/artifacts` }} metadata=".AgentCowork/artifacts" onOpen={(p) => void openPath(p)} />}
    </MessageBubble>
  );
}

function PlanCard({ message, trustedRoot, onPatchAssistant }: { message: AssistantMessage; trustedRoot: string; onPatchAssistant: TimelineProps['onPatchAssistant'] }) {
  const respondToPlan = (approve: boolean) => {
    if (!message.plan) return;
    void respondApproval(message.plan.id, approve ? 'once' : 'reject');
    onPatchAssistant(message.id, (m) => ({ ...m, plan: undefined, status: approve ? 'applying' : 'running' }));
  };
  return <div className="plan-card"><div className="plan-card-head">计划待批准</div><MessageText text={message.plan!.text} trustedRoot={trustedRoot} /><div className="plan-card-actions"><button type="button" className="plan-approve" onClick={() => respondToPlan(true)}>批准并执行</button><button type="button" onClick={() => respondToPlan(false)}>继续完善</button></div></div>;
}

function QuestionCard({ message, onPatchAssistant }: { message: AssistantMessage; onPatchAssistant: TimelineProps['onPatchAssistant'] }) {
  const respondToQuestion = (answer: string) => {
    if (!message.question) return;
    void answerQuestion(message.question.id, answer);
    onPatchAssistant(message.id, (m) => ({ ...m, question: undefined, status: 'running' }));
  };
  return <div className="question-card"><div className="question-q">{message.question!.question}</div><div className="question-options">{message.question!.options.length > 0 ? message.question!.options.map((opt, i) => <button key={i} type="button" onClick={() => respondToQuestion(opt.label)}><strong>{opt.label}</strong>{opt.description && <span>{opt.description}</span>}</button>) : <button type="button" onClick={() => respondToQuestion('继续')}>继续</button>}</div></div>;
}

function ApprovalBar({ message, onPatchAssistant }: { message: AssistantMessage; onPatchAssistant: TimelineProps['onPatchAssistant'] }) {
  const respondToApproval = (decision: 'once' | 'session' | 'reject') => {
    if (!message.approval) return;
    void respondApproval(message.approval.id, decision);
    onPatchAssistant(message.id, (m) => ({ ...m, approval: undefined }));
  };
  return <div className="approval-bar"><span className="approval-q">需要批准操作：<code>{message.approval!.name}</code></span><div className="approval-actions"><button type="button" onClick={() => respondToApproval('once')}>本次批准</button><button type="button" onClick={() => respondToApproval('session')}>本会话批准</button><button type="button" className="reject" onClick={() => respondToApproval('reject')}>拒绝</button></div></div>;
}

function AssistantText({ message, streamingId, trustedRoot, onQuickSend }: { message: AssistantMessage; streamingId: string | null; trustedRoot: string; onQuickSend: (text: string) => void }) {
  const parsed = extractSuggestions(message.text || '');
  return <>{parsed.text && <MessageText text={parsed.text} trustedRoot={trustedRoot} />}{message.id === streamingId && <span className="type-caret" aria-hidden="true" />}{parsed.suggestions.length > 0 && message.status === 'done' && <div className="suggestion-chips">{parsed.suggestions.map((sug, i) => <button key={i} type="button" className="suggestion-chip" onClick={() => onQuickSend(sug)}>{sug}</button>)}</div>}</>;
}
