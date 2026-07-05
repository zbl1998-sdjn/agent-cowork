import type { OrchestrationRecipe } from '../workflow-types.js';

export const weeklyReportRecipe: OrchestrationRecipe = {
  id: 'weekly-report',
  displayName: 'Weekly report sequential workflow',
  mode: 'workflow',
  agents: ['researcher', 'writer', 'verifier', 'security_reviewer'],
  steps: [
    {
      id: 'research',
      kind: 'agent_task',
      agentId: 'researcher',
      title: 'Collect source facts',
      instruction: 'Extract concise weekly facts and evidence references from the supplied context.',
      expectedOutput: 'Grounded bullet summary with evidence references.',
    },
    {
      id: 'write',
      kind: 'agent_task',
      agentId: 'writer',
      title: 'Draft weekly report',
      instruction: 'Turn the research summary into a weekly report draft.',
      expectedOutput: 'Weekly report draft with risks and next steps.',
      dependencies: ['research'],
    },
    {
      id: 'verify',
      kind: 'agent_task',
      agentId: 'verifier',
      title: 'Verify weekly report',
      instruction: 'Check completeness, evidence, placeholders, and contradictions.',
      expectedOutput: 'Verification summary and warnings.',
      dependencies: ['write'],
    },
    {
      id: 'security',
      kind: 'agent_task',
      agentId: 'security_reviewer',
      title: 'Review security policy',
      instruction: 'Check the workflow for secret exposure, write risk, and network risk.',
      expectedOutput: 'Security review result.',
      dependencies: ['verify'],
    },
    { id: 'synthesize', kind: 'synthesis', dependencies: ['security'] },
    { id: 'final_verification', kind: 'verification', dependencies: ['synthesize'], minimumConfidence: 0.5 },
  ],
};
