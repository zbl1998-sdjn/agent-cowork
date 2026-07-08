import { describe, expect, it } from 'vitest';
import { groupKnowledge, confidenceLabel } from './MemoryKnowledgeSection';
import type { KnowledgeItem } from '../../lib/api';

const item = (over: Partial<KnowledgeItem>): KnowledgeItem => ({
  id: 'k1', topic: '项目', title: '项目代号', content: '项目代号是 Phoenix-7',
  confidence: 0.9, status: 'active', scope: 'project', ...over,
});

describe('MemoryKnowledgeSection logic', () => {
  it('groups knowledge items into active and pending', () => {
    const groups = groupKnowledge([
      item({ id: 'a', status: 'active' }),
      item({ id: 'p', status: 'pending' }),
      item({ id: 'a2', status: 'active' }),
    ]);
    expect(groups.active.map((i) => i.id)).toEqual(['a', 'a2']);
    expect(groups.pending.map((i) => i.id)).toEqual(['p']);
  });

  it('tolerates empty / missing input', () => {
    expect(groupKnowledge([])).toEqual({ active: [], pending: [] });
    expect(groupKnowledge(undefined as unknown as KnowledgeItem[])).toEqual({ active: [], pending: [] });
  });

  it('formats confidence as a clamped percentage', () => {
    expect(confidenceLabel(0.9)).toBe('90%');
    expect(confidenceLabel(0)).toBe('0%');
    expect(confidenceLabel(5)).toBe('100%');
    expect(confidenceLabel(-1)).toBe('0%');
    expect(confidenceLabel(NaN)).toBe('0%');
  });
});
