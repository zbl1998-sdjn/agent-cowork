import { describe, expect, it } from 'vitest';
import { runStatusCounts } from './project-viz';
import type { RunRecord } from '../../lib/types';

const run = (status: string): RunRecord => ({ id: `r-${status}-${Math.random()}`, status } as RunRecord);

describe('runStatusCounts', () => {
  it('counts succeeded runs as done (dogfood: run status is "succeeded", not "done")', () => {
    const counts = runStatusCounts([run('succeeded'), run('failed'), run('failed'), run('failed'), run('failed')]);
    expect(counts.done).toBe(1); // 修前恒为 0
    expect(counts.failed).toBe(4);
  });

  it('aggregates all success synonyms into done without double-counting raw done', () => {
    const counts = runStatusCounts([run('succeeded'), run('success'), run('ok'), run('completed'), run('done')]);
    expect(counts.done).toBe(5);
  });

  it('empty and unknown statuses do not inflate done', () => {
    expect(runStatusCounts([]).done).toBe(0);
    expect(runStatusCounts([run('running'), run('unknown')]).done).toBe(0);
  });
});
