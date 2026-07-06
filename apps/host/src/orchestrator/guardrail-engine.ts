import type { AgentDefinition, AgentTask, SecurityMode } from './types.js';

export class GuardrailViolationError extends Error {
  statusCode = 403;
}

export type GuardrailInput = {
  agent: AgentDefinition;
  task: AgentTask;
  securityMode: SecurityMode;
};

export class GuardrailEngine {
  beforeTask({ agent, task, securityMode }: GuardrailInput): void {
    if (agent.requiresApprovalBeforeRun && task.approvalPolicy === 'never') {
      throw new GuardrailViolationError(`Agent ${agent.id} requires approval before run`);
    }
    if (agent.canWrite && task.approvalPolicy === 'never') {
      throw new GuardrailViolationError(`Agent ${agent.id} cannot write without an approval policy`);
    }
    if (securityMode === 'local_strict' && agent.canCallNetwork) {
      throw new GuardrailViolationError(`Agent ${agent.id} cannot call network in local_strict mode`);
    }
    const denied = new Set(agent.deniedTools);
    for (const tool of agent.allowedTools) {
      if (denied.has(tool)) {
        throw new GuardrailViolationError(`Agent ${agent.id} has conflicting tool policy for ${tool}`);
      }
    }
  }
}
