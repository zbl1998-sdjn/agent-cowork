import assert from 'node:assert/strict';
import test from 'node:test';
import { createToolTodoTracker, todoItemsFromPlan } from '../src/kimi/agent/todo-state.js';

test('todoItemsFromPlan turns numbered plan lines into pending todos', () => {
  const items = todoItemsFromPlan('1. 读取现状\n2. 修改文件\n3. 运行测试');

  assert.deepEqual(items.map((item) => item.text), ['读取现状', '修改文件', '运行测试']);
  assert.deepEqual(items.map((item) => item.status), ['pending', 'pending', 'pending']);
  assert.deepEqual(items.map((item) => item.id), ['plan-1', 'plan-2', 'plan-3']);
});

test('createToolTodoTracker emits running and terminal updates for a tool call', () => {
  const events = [];
  const tracker = createToolTodoTracker((type, payload) => events.push({ type, payload }));

  const todo = tracker.start('Read');
  todo.finish('done');

  assert.deepEqual(events, [
    {
      type: 'todo_update',
      payload: { id: 'tool-1-Read', text: '调用 Read', status: 'running', kind: 'tool' },
    },
    {
      type: 'todo_update',
      payload: { id: 'tool-1-Read', text: '调用 Read', status: 'done', kind: 'tool' },
    },
  ]);
});
