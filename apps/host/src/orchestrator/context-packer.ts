import { randomHex } from '../util/ids.js';
import type {
  AgentDefinition,
  ContextPack,
  ContextPackEntry,
  ContextRef,
  RedactionMode,
} from './types.js';

const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{12,}/g,
  /AKIA[0-9A-Z]{12,}/g,
  /\b(?:password|api[_-]?key|token)\s*[:=]\s*["']?[^"'\s]+/gi,
];

export type PackContextInput = {
  agent: AgentDefinition;
  taskId: string;
  userGoal: string;
  refs?: readonly ContextRef[];
};

function cloneEntry(entry: ContextPackEntry): ContextPackEntry {
  return JSON.parse(JSON.stringify(entry)) as ContextPackEntry;
}

function redact(text: string, mode: RedactionMode): { text: string; count: number } {
  if (mode === 'none') {
    return { text, count: 0 };
  }
  let count = 0;
  let output = text;
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, () => {
      count += 1;
      return '[REDACTED]';
    });
  }
  if (mode === 'strict') {
    output = output.replace(/\b\d{11,}\b/g, () => {
      count += 1;
      return '[REDACTED_NUMBER]';
    });
  }
  return { text: output, count };
}

function isAllowed(ref: ContextRef, agent: AgentDefinition): boolean {
  const allowed = new Set(agent.contextPolicy.allowedDataTags);
  return ref.dataTags.every((tag) => allowed.has(tag));
}

export class ContextPacker {
  pack({ agent, taskId, userGoal, refs = [] }: PackContextInput): ContextPack {
    const entries: ContextPackEntry[] = [];
    const forbidden: string[] = [];
    let remainingChars = Math.max(1, agent.contextPolicy.maxInputChars);
    let redactedCount = 0;
    let omittedRefs = 0;
    let truncatedRefs = 0;

    for (const ref of refs) {
      if (!isAllowed(ref, agent)) {
        omittedRefs += 1;
        forbidden.push(ref.refId);
        continue;
      }
      const sourceText = agent.contextPolicy.canSeeRawFiles ? ref.text : ref.summary;
      const { text: redacted, count } = redact(sourceText, agent.contextPolicy.redactionMode);
      redactedCount += count;
      if (remainingChars <= 0) {
        omittedRefs += 1;
        forbidden.push(ref.refId);
        continue;
      }
      const text = redacted.slice(0, remainingChars);
      const truncated = redacted.length > text.length;
      if (truncated) {
        truncatedRefs += 1;
      }
      remainingChars -= text.length;
      entries.push({
        refId: ref.refId,
        kind: ref.kind,
        label: agent.contextPolicy.canSeeFileNames ? ref.label : `source-${entries.length + 1}`,
        dataTags: [...ref.dataTags],
        text,
        truncated,
        uri: agent.contextPolicy.canSeeFileNames ? ref.uri : '',
        metadata: ref.metadata,
      });
    }

    return {
      contextPackId: `ctx_${randomHex(10)}`,
      agentId: agent.id,
      taskId,
      userGoalSummary: userGoal.slice(0, 500),
      entries: entries.map(cloneEntry),
      forbidden,
      redactionReport: {
        mode: agent.contextPolicy.redactionMode,
        redactedCount,
        omittedRefs,
        truncatedRefs,
      },
    };
  }
}
