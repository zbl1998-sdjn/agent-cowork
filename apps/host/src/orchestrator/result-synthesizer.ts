import type { AgentResult, EvidenceRef } from './types.js';

export type SynthesisInput = {
  userGoal: string;
  agentResults: AgentResult[];
  safetyConstraints?: string[];
};

export type SynthesisOutput = {
  finalSummary: string;
  unresolvedQuestions: string[];
  conflicts: string[];
  citations: EvidenceRef[];
  confidence: number;
  warnings: string[];
};

export function synthesizeAgentResults({
  userGoal,
  agentResults,
  safetyConstraints = [],
}: SynthesisInput): SynthesisOutput {
  const usable = agentResults.filter((result) => result.status === 'succeeded' || result.status === 'partial');
  const warnings = agentResults.flatMap((result) => result.warnings);
  const citations = usable.flatMap((result) => result.evidenceRefs);
  const confidence = usable.length === 0
    ? 0
    : usable.reduce((sum, result) => sum + result.confidence, 0) / usable.length;
  const failed = agentResults.filter((result) => result.status === 'failed');
  const finalSummary = [
    `Goal: ${userGoal}`,
    ...usable.map((result) => `${result.agentId}: ${result.summary}`),
    ...failed.map((result) => `${result.agentId}: failed - ${result.summary}`),
  ].join('\n');

  return {
    finalSummary,
    unresolvedQuestions: confidence < 0.75 ? ['Low confidence result needs user review'] : [],
    conflicts: [],
    citations,
    confidence,
    warnings: [...warnings, ...safetyConstraints],
  };
}
