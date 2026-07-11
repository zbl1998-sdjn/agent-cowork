import { describe, expect, it } from 'vitest';
import type { RunRecord } from '../lib/types';
import { createTaskDetailRequestCoordinator } from './useTasksPanel';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('task detail request coordination', () => {
  it('ignores a late response from the previously selected task', async () => {
    const pending = new Map<string, ReturnType<typeof deferred<RunRecord>>>();
    const commits: string[] = [];
    const coordinator = createTaskDetailRequestCoordinator((runId) => {
      const request = deferred<RunRecord>();
      pending.set(runId, request);
      return request.promise;
    });
    const callbacks = {
      onStart: (runId: string) => commits.push(`start:${runId}`),
      onSuccess: (record: RunRecord) => commits.push(`success:${record.id}`),
      onError: (error: unknown) => commits.push(`error:${String(error)}`),
      onSettled: (runId: string) => commits.push(`settled:${runId}`),
    };

    const first = coordinator.load('run_a', callbacks);
    const second = coordinator.load('run_b', callbacks);
    pending.get('run_b')!.resolve({ id: 'run_b', type: 'agent', status: 'done' });
    await second;
    pending.get('run_a')!.resolve({ id: 'run_a', type: 'agent', status: 'done' });
    await first;

    expect(commits).toEqual([
      'start:run_a',
      'start:run_b',
      'success:run_b',
      'settled:run_b',
    ]);
  });

  it('invalidates an in-flight request when the detail view closes', async () => {
    const request = deferred<RunRecord>();
    const commits: string[] = [];
    const coordinator = createTaskDetailRequestCoordinator(() => request.promise);
    const loading = coordinator.load('run_a', {
      onStart: () => commits.push('start'),
      onSuccess: () => commits.push('success'),
      onError: () => commits.push('error'),
      onSettled: () => commits.push('settled'),
    });
    coordinator.invalidate();
    request.reject(new Error('late failure'));
    await loading;

    expect(commits).toEqual(['start']);
  });
});
