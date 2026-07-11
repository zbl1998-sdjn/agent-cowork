// TimelineTurns(UI · components/chat):把一个「回合」(用户消息 + 助手响应/工具调用/进度)渲染成一组气泡;memo 优化。
import { memo, type CSSProperties } from 'react';
import { usePendingAction } from '../../hooks/usePendingAction';
import { answerQuestion, openPath, respondApproval } from '../../lib/api';
import { joinWorkspacePath } from '../../lib/app-logic';
import type { AssistantMessage, UserMessage } from '../../lib/app-types';
import { extractSuggestions } from '../../lib/md';
import {
  clearAcknowledgedAssistantRequest,
  requireAcknowledgement,
} from '../../lib/pending-action';
import { ApprovalActions } from '../ApprovalActions';
import { ArtifactCard } from '../ArtifactCard';
import { MessageActions } from '../MessageActions';
import { MessageBubble } from '../MessageBubble';
import { MessageText } from '../MessageText';
import { PreviewCard } from '../PreviewCard';
import { ProgressLine } from '../ProgressLine';
import { RecipeDraftCard } from '../RecipeDraftCard';
import { SourcesFooter } from '../SourcesFooter';
import { SubtaskGroups } from '../SubtaskGroups';
import { TaskStatusBadge } from '../TaskStatusBadge';
import { TodoList } from '../TodoList';
import { ToolCallCard } from '../ToolCallCard';
import { Button } from '../ui/Button';
import { ChoiceButton } from '../ui/ChoiceButton';
import { ApprovalDecisionBar } from './ApprovalDecisionBar';

type PatchAssistant = (id: string, patch: (message: AssistantMessage) => AssistantMessage) => void;

const suggestionChipStyle: CSSProperties = {
  borderColor: '#e3d9d3',
  background: '#fbf7f5',
  color: '#b5482f',
  borderRadius: 14,
  padding: '6px 12px',
  fontSize: 12.5,
};

export interface UserTurnProps {
  message: UserMessage;
  streamingId: string | null;
  onBeginEdit: (messageId: string, text: string) => void;
}

export function userTurnPropsEqual(prev: UserTurnProps, next: UserTurnProps): boolean {
  return prev.message === next.message
    && prev.streamingId === next.streamingId
    && prev.onBeginEdit === next.onBeginEdit;
}

export const UserTurn = memo(function UserTurn({ message, streamingId, onBeginEdit }: UserTurnProps) {
  return (
    <MessageBubble role="user">
      <span className="user-msg-text">{message.text}</span>
      {!streamingId && (
        <Button
          variant="ghost"
          className="user-edit-btn"
          title="编辑并重新发送"
          onClick={() => onBeginEdit(message.id, message.text)}
          style={{ marginLeft: 10, border: 'none', background: 'none', color: 'var(--muted)', padding: 0, fontSize: 12 }}
        >
          ✎ 编辑
        </Button>
      )}
    </MessageBubble>
  );
}, userTurnPropsEqual);

export interface UserEditTurnProps {
  editText: string;
  message: UserMessage;
  onSetEditingMsgId: (id: string | null) => void;
  onSetEditText: (text: string) => void;
  onSubmitEdit: (messageId: string) => void;
}

export function userEditTurnPropsEqual(prev: UserEditTurnProps, next: UserEditTurnProps): boolean {
  return prev.editText === next.editText
    && prev.message === next.message
    && prev.onSetEditingMsgId === next.onSetEditingMsgId
    && prev.onSetEditText === next.onSetEditText
    && prev.onSubmitEdit === next.onSubmitEdit;
}

export const UserEditTurn = memo(function UserEditTurn({ editText, message, onSetEditingMsgId, onSetEditText, onSubmitEdit }: UserEditTurnProps) {
  return (
    <div className="user-edit">
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
        <Button variant="secondary" onClick={() => onSetEditingMsgId(null)}>取消</Button>
        <Button variant="primary" onClick={() => onSubmitEdit(message.id)}>重新发送</Button>
      </div>
    </div>
  );
}, userEditTurnPropsEqual);

export interface AssistantTurnProps {
  message: AssistantMessage;
  streamingId: string | null;
  trustedRoot: string;
  onCopyText: (text: string) => void;
  onHandleApprove: (message: AssistantMessage) => void;
  onOpenOrPreview: (path: string) => void;
  onPatchAssistant: PatchAssistant;
  onQuickSend: (text: string) => void;
  onCaptureRecipe: (assistantId: string, runId: string) => void;
  onRegenerate: (assistantId: string) => void;
  onResumeRun: (runId: string) => void;
}

export function assistantContinueRunId(message: AssistantMessage): string | null {
  // 失败/取消可续跑;另外「自动续跑到硬上限仍没做完」的 done 也允许携原 runId 续跑接着做。
  const continuable = message.status === 'failed' || message.status === 'cancelled' || message.stepsExhausted === true;
  if (!continuable) return null;
  const runId = message.runId?.trim();
  return runId || null;
}

export function assistantTurnPropsEqual(prev: AssistantTurnProps, next: AssistantTurnProps): boolean {
  return prev.message === next.message
    && prev.streamingId === next.streamingId
    && prev.trustedRoot === next.trustedRoot
    && prev.onCopyText === next.onCopyText
    && prev.onHandleApprove === next.onHandleApprove
    && prev.onOpenOrPreview === next.onOpenOrPreview
    && prev.onPatchAssistant === next.onPatchAssistant
    && prev.onQuickSend === next.onQuickSend
    && prev.onCaptureRecipe === next.onCaptureRecipe
    && prev.onRegenerate === next.onRegenerate
    && prev.onResumeRun === next.onResumeRun;
}

export const AssistantTurn = memo(function AssistantTurn({ message, streamingId, trustedRoot, onCopyText, onHandleApprove, onOpenOrPreview, onPatchAssistant, onQuickSend, onCaptureRecipe, onRegenerate, onResumeRun }: AssistantTurnProps) {
  const canShowActions = Boolean(message.text && (message.status === 'done' || message.status === 'failed' || message.status === 'cancelled'));
  const canContinue = message.status === 'failed' || message.status === 'cancelled' || message.stepsExhausted === true;
  const canCaptureRecipe = Boolean(message.runId && message.status === 'done');
  const captureRecipeLabel = message.recipeCaptureStatus === 'capturing' ? '保存中' : message.recipeCaptureStatus === 'captured' ? '已存草稿' : '存为技能';
  const resumeRunId = assistantContinueRunId(message);
  const continueRun = resumeRunId ? () => onResumeRun(resumeRunId) : () => onQuickSend('继续');
  return (
    <MessageBubble role="assistant" status="" runId={message.runId}>
      {(message.status === 'thinking' || message.status === 'streaming') && !message.text && <div className="turn-status" role="status" aria-live="polite" aria-atomic="true">{message.reasoning ? '思考中' : '正在响应'}<span className="typing-dots" aria-hidden="true"><i /><i /><i /></span></div>}
      {message.reasoning && <details className="reasoning" open={!message.text}><summary>思考过程</summary><div className="reasoning-body">{message.reasoning}</div></details>}
      {message.todos && message.todos.length > 0 && <TodoList items={message.todos} />}
      {message.subtasks && message.subtasks.length > 0 && <SubtaskGroups items={message.subtasks} />}
      {message.progress.map((p, i) => <ProgressLine key={i} {...p} />)}
      {message.tools && message.tools.length > 0 && <div className="toolcalls">{message.tools.map((t, i) => <ToolCallCard key={i} call={t} />)}</div>}
      {message.plan && <PlanCard message={message} trustedRoot={trustedRoot} onPatchAssistant={onPatchAssistant} />}
      {message.question && <QuestionCard message={message} onPatchAssistant={onPatchAssistant} />}
      {message.approval && <ApprovalDecisionBar message={message} onPatchAssistant={onPatchAssistant} />}
      {message.text && <AssistantText message={message} streamingId={streamingId} trustedRoot={trustedRoot} onQuickSend={onQuickSend} />}
      {message.recipeDraft && <RecipeDraftCard draft={message.recipeDraft} />}
      {message.recipeCaptureStatus === 'failed' && message.recipeCaptureError && <div className="panel-error">{message.recipeCaptureError}</div>}
      {message.files && message.files.length > 0 && <div className="file-cards">{message.files.map((fp, i) => <ArtifactCard key={`${fp}-${i}`} file={{ path: joinWorkspacePath(trustedRoot, fp), relativePath: fp }} metadata={fp} onOpen={onOpenOrPreview} />)}</div>}
      {message.operations.length > 0 && <PreviewCard operations={message.operations} aiGenerated={message.aiGenerated} />}
      {message.operations.length > 0 && <ApprovalActions runId={message.runId || ''} operations={message.operations} approvalState={message.approvalState} onApprove={() => onHandleApprove(message)} onReject={() => onPatchAssistant(message.id, (m) => ({ ...m, approvalState: 'rejected' }))} />}
      <SourcesFooter sources={message.sources} />
      {canShowActions && <MessageActions onCopy={() => onCopyText(extractSuggestions(message.text || '').text)} onContinue={canContinue ? continueRun : undefined} onCaptureRecipe={canCaptureRecipe && message.runId ? () => onCaptureRecipe(message.id, message.runId || '') : undefined} captureRecipeDisabled={message.recipeCaptureStatus === 'capturing' || message.recipeCaptureStatus === 'captured'} captureRecipeLabel={canCaptureRecipe ? captureRecipeLabel : undefined} onRegenerate={() => onRegenerate(message.id)} />}
      {message.usage && message.usage.total_tokens ? <div className="usage-line">用量 {message.usage.total_tokens} tokens</div> : null}
      {message.operations.length > 0 && <TaskStatusBadge runId={message.runId} status={message.status} />}
      {message.approvalState === 'approved' && <ArtifactCard file={{ path: `${trustedRoot}/.AgentCowork/artifacts` }} metadata=".AgentCowork/artifacts" onOpen={(p) => void openPath(p)} />}
    </MessageBubble>
  );
}, assistantTurnPropsEqual);

function PlanCard({ message, trustedRoot, onPatchAssistant }: { message: AssistantMessage; trustedRoot: string; onPatchAssistant: PatchAssistant }) {
  const plan = message.plan;
  const { pending, error, run } = usePendingAction('提交计划决定');
  const respondToPlan = (approve: boolean) => {
    if (!plan) return;
    void run(() => requireAcknowledgement(
      () => respondApproval(plan.id, approve ? 'once' : 'reject'),
      () => onPatchAssistant(message.id, (m) => clearAcknowledgedAssistantRequest(
        m,
        'plan',
        plan.id,
        { status: approve ? 'applying' : 'running' },
      )),
    ));
  };
  if (!plan) return null;
  return (
    <div className="plan-card">
      <div className="plan-card-head">计划待批准</div>
      <MessageText text={plan.text} trustedRoot={trustedRoot} />
      <div className="plan-card-actions">
        <Button variant="primary" disabled={pending} onClick={() => respondToPlan(true)}>{pending ? '提交中…' : '批准并执行'}</Button>
        <Button variant="secondary" disabled={pending} onClick={() => respondToPlan(false)}>继续完善</Button>
      </div>
      {error && <div className="panel-error" role="alert">{error}</div>}
    </div>
  );
}

function QuestionCard({ message, onPatchAssistant }: { message: AssistantMessage; onPatchAssistant: PatchAssistant }) {
  const question = message.question;
  const { pending, error, run } = usePendingAction('提交问题答案');
  const respondToQuestion = (answer: string) => {
    if (!question) return;
    void run(() => requireAcknowledgement(
      () => answerQuestion(question.id, answer),
      () => onPatchAssistant(message.id, (m) => clearAcknowledgedAssistantRequest(
        m,
        'question',
        question.id,
        { status: 'running' },
      )),
    ));
  };
  if (!question) return null;
  return (
    <div className="question-card">
      <div className="question-q">{question.question}</div>
      <div className="question-options">
        {question.options.length > 0 ? question.options.map((opt, i) => (
          <ChoiceButton key={i} tone="warm" disabled={pending} label={opt.label} detail={opt.description} onClick={() => respondToQuestion(opt.label)} />
        )) : (
          <ChoiceButton tone="warm" disabled={pending} label={pending ? '提交中…' : '继续'} onClick={() => respondToQuestion('继续')} />
        )}
      </div>
      {error && <div className="panel-error" role="alert">{error}</div>}
    </div>
  );
}

function AssistantText({ message, streamingId, trustedRoot, onQuickSend }: { message: AssistantMessage; streamingId: string | null; trustedRoot: string; onQuickSend: (text: string) => void }) {
  const parsed = extractSuggestions(message.text || '');
  return <>{parsed.text && <MessageText text={parsed.text} trustedRoot={trustedRoot} />}{message.id === streamingId && <span className="type-caret" aria-hidden="true" />}{parsed.suggestions.length > 0 && message.status === 'done' && <div className="suggestion-chips">{parsed.suggestions.map((sug, i) => <Button key={i} className="suggestion-chip" onClick={() => onQuickSend(sug)} style={suggestionChipStyle}>{sug}</Button>)}</div>}</>;
}
