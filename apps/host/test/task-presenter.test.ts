import assert from 'node:assert/strict';
import test from 'node:test';
import { taskFromRun } from '../src/runtime/task-presenter.js';

test('taskFromRun preserves review-relevant terminal and approval states', () => {
  assert.deepEqual(taskFromRun({ id: 'run_waiting', status: 'awaiting_approval' }), {
    id: 'run_waiting',
    status: 'awaiting_approval',
    activeForm: '等待审批',
  });
  assert.deepEqual(taskFromRun({ id: 'run_cancelled', status: 'cancelled' }), {
    id: 'run_cancelled',
    status: 'cancelled',
    activeForm: '已取消',
  });
});

test('taskFromRun exposes a persisted failure message for review', () => {
  assert.deepEqual(taskFromRun({
    id: 'run_failed',
    status: 'failed',
    prompt: '生成周报',
    error: '模型服务不可用',
  }), {
    id: 'run_failed',
    status: 'failed',
    activeForm: '需要查看错误',
    prompt: '生成周报',
    error: '模型服务不可用',
  });
});
