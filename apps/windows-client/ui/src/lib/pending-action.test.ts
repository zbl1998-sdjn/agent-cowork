import { describe, expect, it, vi } from 'vitest';
import type { AssistantMessage } from './app-types';
import {
  clearAcknowledgedAssistantRequest,
  createPendingActionGate,
  requireAcknowledgement,
  setPendingApprovalError,
} from './pending-action';

const baseAssistant: AssistantMessage = {
  id: 'assistant-1',
  role: 'assistant',
  status: 'awaiting_approval',
  progress: [],
  operations: [],
  sources: [],
  approvalState: 'idle',
};

describe('pending action guard', () => {
  it('fails closed when the host does not acknowledge the action', async () => {
    const onAcknowledged = vi.fn();

    await expect(requireAcknowledgement(async () => false, onAcknowledged))
      .rejects.toThrow('未确认');
    expect(onAcknowledged).not.toHaveBeenCalled();
  });

  it('keeps a rejected transport promise visible to the caller', async () => {
    await expect(requireAcknowledgement(
      async () => { throw new Error('network down'); },
      vi.fn(),
    )).rejects.toThrow('network down');
  });

  it('allows only one in-flight submission and reopens after it settles', async () => {
    const gate = createPendingActionGate();
    let release: (() => void) | undefined;
    const work = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));

    const first = gate.run(work);
    await expect(gate.run(work)).resolves.toBe(false);
    expect(work).toHaveBeenCalledTimes(1);

    release?.();
    await expect(first).resolves.toBe(true);
    await expect(gate.run(async () => undefined)).resolves.toBe(true);
  });

  it('does not let an old acknowledgement clear a newer pending request or overwrite its status', () => {
    const withNewPlan: AssistantMessage = {
      ...baseAssistant,
      status: 'streaming',
      plan: { id: 'plan-new', text: 'new plan' },
    };
    const withNewQuestion: AssistantMessage = {
      ...baseAssistant,
      status: 'streaming',
      question: { id: 'question-new', question: 'new question', options: [] },
    };
    const withNewApproval: AssistantMessage = {
      ...baseAssistant,
      approval: { id: 'approval-new', name: 'Shell', sessionReusable: false },
    };
    const terminalPlan: AssistantMessage = {
      ...baseAssistant,
      status: 'done',
      plan: { id: 'plan-current', text: 'completed plan' },
    };

    expect(clearAcknowledgedAssistantRequest(withNewPlan, 'plan', 'plan-old', { status: 'applying' })).toBe(withNewPlan);
    expect(clearAcknowledgedAssistantRequest(withNewQuestion, 'question', 'question-old', { status: 'running' })).toBe(withNewQuestion);
    expect(clearAcknowledgedAssistantRequest(withNewApproval, 'approval', 'approval-old')).toBe(withNewApproval);
    expect(clearAcknowledgedAssistantRequest(terminalPlan, 'plan', 'plan-current', { status: 'applying' })).toMatchObject({
      status: 'done',
      plan: undefined,
    });
  });

  it('clears only the matching request and persists an error only on the matching approval', () => {
    const message: AssistantMessage = {
      ...baseAssistant,
      approval: { id: 'approval-current', name: 'Write', sessionReusable: true },
    };

    expect(clearAcknowledgedAssistantRequest(message, 'approval', 'approval-current').approval).toBeUndefined();
    expect(setPendingApprovalError(message, 'approval-old', 'old failure')).toBe(message);
    expect(setPendingApprovalError(message, 'approval-current', 'host rejected').approval?.error).toBe('host rejected');
  });
});
