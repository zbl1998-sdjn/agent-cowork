import { describe, expect, it } from 'vitest';
import {
  buildUsageDisplayRows,
  formatDurationMs,
  formatEstimatedCost,
  formatTokenCount,
} from './usage-display';

describe('usage display helpers', () => {
  it('formats token counts, durations, and local estimated costs', () => {
    expect(formatTokenCount(12345.2)).toBe('12,345 tokens');
    expect(formatDurationMs(950)).toBe('950 ms');
    expect(formatDurationMs(1250)).toBe('1.3 s');
    expect(formatDurationMs(65_000)).toBe('1m 5s');
    expect(formatEstimatedCost({ total: 0.000032, currency: 'USD', estimated: true })).toBe('≈USD 0.00003');
  });

  it('builds stable rows for the backend transparency contract', () => {
    const rows = buildUsageDisplayRows({
      model: 'local-test',
      tokens: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      cost: { currency: 'USD', total: 0.02, estimated: true, source: 'local-estimate' },
      duration: {
        totalMs: 2000,
        phases: [{ key: 'model', label: 'Model', durationMs: 1500, percent: 75 }],
        unaccountedMs: 500,
      },
      disclosure: { estimated: true, source: 'local-estimate', requiresSecret: false },
    });

    expect(rows).toEqual([
      { label: 'Tokens', value: '15 tokens', tone: 'neutral' },
      { label: 'Prompt', value: '10 tokens', tone: 'muted' },
      { label: 'Completion', value: '5 tokens', tone: 'muted' },
      { label: 'Cost', value: '≈USD 0.02', tone: 'neutral' },
      { label: 'Elapsed', value: '2 s', tone: 'neutral' },
      { label: 'Model', value: '1.5 s (75.0%)', tone: 'muted' },
      { label: 'Other', value: '500 ms', tone: 'muted' },
      { label: 'Estimate', value: 'local-estimate', tone: 'muted' },
    ]);
  });
});
