import { describe, expect, it } from 'vitest';
import {
  buildAgentChatStreamOptions,
  hasSessionModelAccess,
  mergeTodoUpdate,
  progressStatusFromIcon,
  reconcileChatEnabled,
  reduceAssistantRunEvent,
  type AssistantRunState,
} from './app-logic';
import type { RunEvent } from './types';

function baseMessage(overrides: Partial<AssistantRunState> = {}): AssistantRunState {
  return {
    status: 'running',
    progress: [],
    sources: [],
    approvalState: 'idle',
    ...overrides,
  };
}

function event(partial: Partial<RunEvent> & Pick<RunEvent, 'type'>): RunEvent {
  return { seq: 1, ts: '2026-05-24T00:00:00.000Z', ...partial };
}

describe('progressStatusFromIcon', () => {
  it('maps host progress icons to UI statuses', () => {
    expect(progressStatusFromIcon('check')).toBe('done');
    expect(progressStatusFromIcon('loader')).toBe('running');
    expect(progressStatusFromIcon('unknown')).toBe('wait');
    expect(progressStatusFromIcon()).toBe('wait');
  });
});

describe('reduceAssistantRunEvent', () => {
  it('appends progress updates with the host icon mapped to a status', () => {
    const next = reduceAssistantRunEvent(baseMessage(), event({
      type: 'progress',
      icon: 'loader',
      text: '读取文件',
    }));

    expect(next.progress).toEqual([{ status: 'running', text: '读取文件' }]);
  });

  it('records tool success and failure as user-visible progress lines', () => {
    const afterSuccess = reduceAssistantRunEvent(baseMessage(), event({
      type: 'tool_result',
      status: 'succeeded',
      tool: 'Read',
    }));
    const afterFailure = reduceAssistantRunEvent(afterSuccess, event({
      type: 'tool_result',
      status: 'failed',
      tool: 'Write',
    }));

    expect(afterFailure.progress).toEqual([
      { status: 'done', text: '完成: Read' },
      { status: 'failed', text: '失败: Write' },
    ]);
  });

  it('updates sources, approval state, and final status without mutating the input', () => {
    const original = baseMessage({ sources: [{ path: 'old.md' }] });
    const withSources = reduceAssistantRunEvent(original, event({
      type: 'sources',
      items: [{ path: 'new.md', excerpt: 'evidence' }],
    }));
    const awaiting = reduceAssistantRunEvent(withSources, event({ type: 'awaiting_approval' }));
    const done = reduceAssistantRunEvent(awaiting, event({ type: 'assistant_end', status: 'failed' }));

    expect(original.sources).toEqual([{ path: 'old.md' }]);
    expect(withSources.sources).toEqual([{ path: 'new.md', excerpt: 'evidence' }]);
    expect(awaiting.status).toBe('awaiting_approval');
    expect(awaiting.approvalState).toBe('awaiting');
    expect(done.status).toBe('failed');
  });

  it('stores todo snapshots and merges todo updates by id', () => {
    const snap = reduceAssistantRunEvent(baseMessage(), event({
      type: 'todo_snapshot',
      todos: [
        { id: 'plan-1', text: '读取现状', status: 'pending' },
        { id: 'plan-2', text: '运行测试', status: 'pending' },
      ],
    }));
    const running = reduceAssistantRunEvent(snap, event({
      type: 'todo_update',
      id: 'plan-1',
      text: '读取现状',
      status: 'running',
    }));
    const done = reduceAssistantRunEvent(running, event({
      type: 'todo_update',
      id: 'plan-1',
      text: '读取现状',
      status: 'done',
    }));

    expect(done.todos).toEqual([
      { id: 'plan-1', text: '读取现状', status: 'done' },
      { id: 'plan-2', text: '运行测试', status: 'pending' },
    ]);
  });

  it('groups parallel child lifecycle events by child index', () => {
    const first = reduceAssistantRunEvent(baseMessage(), event({
      type: 'child_start',
      index: 0,
      goal: '审查 A 文件夹',
      stepCount: 2,
    }));
    const second = reduceAssistantRunEvent(first, event({
      type: 'child_start',
      index: 1,
      goal: '审查 B 文件夹',
      stepCount: 1,
    }));
    const done = reduceAssistantRunEvent(second, event({
      type: 'child_end',
      index: 0,
      runId: 'run_child_a',
      status: 'succeeded',
    }));

    expect(done).toMatchObject({
      subtasks: [
        { index: 0, goal: '审查 A 文件夹', status: 'done', runId: 'run_child_a', stepCount: 2 },
        { index: 1, goal: '审查 B 文件夹', status: 'running', stepCount: 1 },
      ],
    });
  });
});

describe('mergeTodoUpdate', () => {
  it('appends new todos and ignores malformed updates', () => {
    expect(mergeTodoUpdate([], { id: 'tool-1', text: '调用 Read', status: 'running' })).toEqual([
      { id: 'tool-1', text: '调用 Read', status: 'running' },
    ]);
    expect(mergeTodoUpdate([{ id: 'tool-1', text: '调用 Read', status: 'running' }], { id: '', text: '' })).toEqual([
      { id: 'tool-1', text: '调用 Read', status: 'running' },
    ]);
  });
});

describe('reconcileChatEnabled', () => {
  it('keeps an already-enabled chat session enabled without scheduling state writes', () => {
    expect(reconcileChatEnabled(true, { chatEnabled: false })).toEqual({
      enabled: true,
      shouldUpdateState: false,
    });
  });

  it('self-heals stale false state when refreshed host info says chat is configured', () => {
    expect(reconcileChatEnabled(false, { chatEnabled: true })).toEqual({
      enabled: true,
      shouldUpdateState: true,
    });
  });

  it('stays disabled when refresh fails or reports disabled', () => {
    expect(reconcileChatEnabled(false, null)).toEqual({ enabled: false, shouldUpdateState: false });
    expect(reconcileChatEnabled(false, { chatEnabled: false })).toEqual({
      enabled: false,
      shouldUpdateState: false,
    });
  });
});

describe('buildAgentChatStreamOptions', () => {
  it('passes per-session model config only when present', () => {
    expect(buildAgentChatStreamOptions({
      trustedRoot: 'C:/work',
      model: 'moonshot-v1',
      thinking: 'standard',
      autoApprove: false,
      planMode: true,
      images: ['C:/work/a.png'],
      resumeRunId: 'run_resume',
    })).not.toHaveProperty('modelConfig');
    expect(buildAgentChatStreamOptions({
      trustedRoot: 'C:/work',
      resumeRunId: 'run_resume',
    })).toMatchObject({ trustedRoot: 'C:/work', resumeRunId: 'run_resume' });

    expect(buildAgentChatStreamOptions({
      trustedRoot: 'C:/work',
      model: 'gpt-4.1',
      modelConfig: {
        provider: 'openai',
        model: 'gpt-4.1',
        baseUrl: 'https://api.openai.test/v1',
        apiKey: 'sk-session',
      },
      thinking: 'deep',
      autoApprove: true,
      planMode: false,
      images: [],
    })).toMatchObject({
      trustedRoot: 'C:/work',
      model: 'gpt-4.1',
      modelConfig: {
        provider: 'openai',
        model: 'gpt-4.1',
        baseUrl: 'https://api.openai.test/v1',
        apiKey: 'sk-session',
      },
      thinking: 'deep',
      autoApprove: true,
      planMode: false,
      images: [],
    });
  });
});

describe('hasSessionModelAccess', () => {
  it('allows BYO-key and local OpenAI-compatible session models through the chat gate', () => {
    expect(hasSessionModelAccess({ apiKey: ' sk-session ' })).toBe(true);
    expect(hasSessionModelAccess({ provider: 'anthropic', model: 'claude-test', apiKey: 'sk-ant' })).toBe(true);
    expect(hasSessionModelAccess({ provider: 'anthropic', model: 'claude-test' })).toBe(false);
    expect(hasSessionModelAccess({ provider: 'openai/local', model: 'local-model' })).toBe(true);
    expect(hasSessionModelAccess({ provider: 'local-openai', model: 'local-model' })).toBe(true);
    expect(hasSessionModelAccess({ provider: 'openai', model: 'gpt-4.1' })).toBe(false);
    expect(hasSessionModelAccess()).toBe(false);
  });
});
