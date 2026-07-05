import { describe, expect, it, vi } from 'vitest';
import { applyToolResult, buildChatStreamCallbacks, contextCompactionProgressText, humanizeChatTurnError } from './chat-stream-callbacks';
import type { AssistantMessage } from './app-types';

function emptyAssistant(): AssistantMessage {
  return {
    id: 'a1',
    role: 'assistant',
    status: 'thinking',
    progress: [],
    operations: [],
    sources: [],
    approvalState: 'idle',
  };
}

function makeHarness(mode: 'plan' | 'execute' | 'yolo' = 'execute') {
  let state = emptyAssistant();
  const patchAssistant = vi.fn((_id: string, fn: (m: AssistantMessage) => AssistantMessage) => {
    state = fn(state);
  });
  const setStreamingId = vi.fn();
  const cb = buildChatStreamCallbacks({ assistantId: 'a1', patchAssistant, setStreamingId, mode });
  return { cb, patchAssistant, setStreamingId, getState: () => state };
}

describe('buildChatStreamCallbacks', () => {
  it('onStart records the runId on the assistant message', () => {
    const { cb, getState } = makeHarness();
    cb.onStart?.('run-42');
    expect(getState().runId).toBe('run-42');
  });

  it('onReasoning appends to reasoning text', () => {
    const { cb, getState } = makeHarness();
    cb.onReasoning?.('first ');
    cb.onReasoning?.('chunk');
    expect(getState().reasoning).toBe('first chunk');
  });

  it('onToken appends to text and flips status to streaming', () => {
    const { cb, getState } = makeHarness();
    cb.onToken?.('hello ');
    cb.onToken?.('world');
    expect(getState().text).toBe('hello world');
    expect(getState().status).toBe('streaming');
  });

  it('onToolCall pushes a running tool entry', () => {
    const { cb, getState } = makeHarness();
    cb.onToolCall?.('Read', { path: '/a' });
    const tools = getState().tools!;
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe('Read');
    expect(tools[0]!.status).toBe('running');
    expect(tools[0]!.startedAt).toBeTypeOf('number');
  });


  it('onContextCompacted appends a visible progress line', () => {
    const { cb, getState } = makeHarness();
    cb.onContextCompacted?.({ beforeTokens: 12345, afterTokens: 6789, keyFacts: ['important: keep context'] });

    expect(getState().progress).toEqual([
      { status: 'done', text: '已自动压缩上下文:12.3K tokens -> 6.8K tokens' },
    ]);
    expect(contextCompactionProgressText({})).toBe('已自动压缩上下文');
  });  it('onDone clears streamingId and finalises text/usage', () => {
    const { cb, getState, setStreamingId } = makeHarness();
    cb.onToken?.('partial');
    cb.onDone?.({ text: 'final answer', runId: 'r1', usage: { total_tokens: 42 } });
    expect(setStreamingId).toHaveBeenCalledWith(null);
    expect(getState().status).toBe('done');
    expect(getState().text).toBe('final answer');
    expect(getState().usage?.total_tokens).toBe(42);
  });

  it('onDone marks leftover plan todos done so the checklist does not stay stuck at 待处理', () => {
    const { cb, getState } = makeHarness('plan');
    cb.onTodoSnapshot?.([
      { id: 'plan-1', text: '提取合同要点', status: 'pending', kind: 'plan' },
      { id: 'plan-2', text: '汇总发票数据', status: 'pending', kind: 'plan' },
      { id: 'tool-1-Write', text: '调用 Write', status: 'done', kind: 'tool' },
    ]);
    cb.onDone?.({ text: '完成。' });
    const todos = getState().todos!;
    expect(todos.find((t) => t.id === 'plan-1')!.status).toBe('done');
    expect(todos.find((t) => t.id === 'plan-2')!.status).toBe('done');
    expect(todos.find((t) => t.id === 'tool-1-Write')!.status).toBe('done');
  });

  it('onCancelled uses friendly fallback text when no body was streamed', () => {
    const { cb, getState, setStreamingId } = makeHarness();
    cb.onCancelled?.({ text: '' });
    expect(setStreamingId).toHaveBeenCalledWith(null);
    expect(getState().status).toBe('cancelled');
    expect(getState().text).toContain('已取消本轮运行');
  });

  it('onCancelled clears parked approval/plan/question and marks running tools cancelled', () => {
    const { cb, getState } = makeHarness('execute');
    cb.onToolCall?.('Shell', { command: 'dir' });
    cb.onApprovalRequest?.('appr-9', 'Shell', undefined);
    cb.onPlanProposed?.('plan-1', '步骤一');
    cb.onQuestion?.('q-1', '继续吗?', []);
    cb.onCancelled?.({ text: '' });
    const state = getState();
    expect(state.approval).toBeUndefined();
    expect(state.plan).toBeUndefined();
    expect(state.question).toBeUndefined();
    expect(state.tools?.[0]?.status).toBe('cancelled');
  });

  it('onError marks the message failed with the raw error string', () => {
    const { cb, getState, setStreamingId } = makeHarness();
    cb.onError?.('upstream blew up');
    expect(setStreamingId).toHaveBeenCalledWith(null);
    expect(getState().status).toBe('failed');
    expect(getState().text).toBe('upstream blew up');
  });

  it('onApprovalRequest in execute mode parks an approval on the message', () => {
    const { cb, getState } = makeHarness('execute');
    cb.onApprovalRequest?.('appr-1', 'Bash', undefined);
    expect(getState().approval).toEqual({ id: 'appr-1', name: 'Bash' });
  });

  it('onApprovalRequest in YOLO mode auto-approves without parking the request', () => {
    // hook 通过 fire-and-forget 的 void 调用 respondApproval;这里仅断言消息上不会堆积审批,
    // API 客户端调用由独立测试覆盖。
    const { cb, getState } = makeHarness('yolo');
    cb.onApprovalRequest?.('appr-1', 'Bash', undefined);
    expect(getState().approval).toBeUndefined();
  });
});

describe('applyToolResult', () => {
  it('merges status/result/duration onto the most recent running entry', () => {
    const startedAt = Date.now() - 1234;
    const initial = [
      { name: 'Read', status: 'running' as const, startedAt },
    ];
    const next = applyToolResult(initial, 'Read', 'ok', { content: 'hello' });
    expect(next).toHaveLength(1);
    expect(next[0]!.status).toBe('ok');
    expect(next[0]!.result).toEqual({ content: 'hello' });
    expect(next[0]!.durationMs).toBeGreaterThanOrEqual(1000);
  });

  it('honours an explicit durationMs from the host over the local clock', () => {
    const initial = [{ name: 'Read', status: 'running' as const, startedAt: Date.now() - 5000 }];
    const next = applyToolResult(initial, 'Read', 'ok', null, 999);
    expect(next[0]!.durationMs).toBe(999);
  });

  it('extracts an error string when the result has one', () => {
    const initial = [{ name: 'Read', status: 'running' as const, startedAt: Date.now() }];
    const next = applyToolResult(initial, 'Read', 'failed', { error: 'EACCES' });
    expect(next[0]!.error).toBe('EACCES');
  });

  it('only merges into the most recent running entry with the matching name', () => {
    const now = Date.now();
    const initial = [
      { name: 'Read', status: 'ok' as const, startedAt: now - 5000, finishedAt: now - 4000 },
      { name: 'Read', status: 'running' as const, startedAt: now - 1000 },
    ];
    const next = applyToolResult(initial, 'Read', 'ok', { content: 'two' });
    expect(next[0]!.status).toBe('ok');
    expect(next[0]!.result).toBeUndefined(); // first entry untouched
    expect(next[1]!.status).toBe('ok');
    expect(next[1]!.result).toEqual({ content: 'two' });
  });

  it('handles undefined tool list', () => {
    expect(applyToolResult(undefined, 'X', 'ok', null)).toEqual([]);
  });
});

describe('humanizeChatTurnError', () => {
  it('wraps ECONNREFUSED in friendly Chinese with the turn-level action verb', () => {
    expect(humanizeChatTurnError(new Error('connect ECONNREFUSED 127.0.0.1:51873')))
      .toContain('Agent Cowork 后台');
  });

  it('keeps the action verb on the fallback path', () => {
    expect(humanizeChatTurnError(new Error('unclassified weirdness')))
      .toBe('本轮对话失败:unclassified weirdness');
  });
});
