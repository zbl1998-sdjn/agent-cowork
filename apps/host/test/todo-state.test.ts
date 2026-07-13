import assert from 'node:assert/strict';
import test from 'node:test';
import { createTodoItem, createToolTodoTracker, todoItemsFromPlan } from '../src/engine/agent/todo-state.js';
import type { TodoItem } from '../src/engine/agent/todo-state.js';

test('todoItemsFromPlan turns numbered plan lines into pending todos', () => {
  const items = todoItemsFromPlan('1. 读取现状\n2. 修改文件\n3. 运行测试');

  assert.deepEqual(items.map((item) => item.text), ['读取现状', '修改文件', '运行测试']);
  assert.deepEqual(items.map((item) => item.status), ['pending', 'pending', 'pending']);
  assert.deepEqual(items.map((item) => item.id), ['plan-1', 'plan-2', 'plan-3']);
});

test('createTodoItem normalizes invalid inputs and bounds optional fields', () => {
  const item = createTodoItem({
    id: '   ',
    text: '   ',
    status: 'unknown',
    detail: 'x'.repeat(300),
    kind: 123,
  });

  assert.match(item.id, /^todo-\d+$/);
  assert.equal(item.text, '待处理任务');
  assert.equal(item.status, 'pending');
  assert.equal(item.detail?.length, 240);
  assert.equal(item.kind, '123');
});

test('todoItemsFromPlan strips markers, de-duplicates, and clamps output', () => {
  const items = todoItemsFromPlan(' - "Read repo"\n[x] read repo\n### Write tests\n3) Run checks', { maxItems: 2 });

  assert.deepEqual(items.map((item) => item.text), ['Read repo', 'Write tests']);
  assert.deepEqual(items.map((item) => item.id), ['plan-1', 'plan-2']);
  assert.deepEqual(items.map((item) => item.kind), ['plan', 'plan']);
});

test('createToolTodoTracker emits running and terminal updates for a tool call', () => {
  const events: Array<{ type: 'todo_update'; payload: TodoItem }> = [];
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

test('createToolTodoTracker maps succeeded to done and unknown terminal states to failed', () => {
  const events: Array<{ type: 'todo_update'; payload: TodoItem }> = [];
  const tracker = createToolTodoTracker((type, payload) => events.push({ type, payload }));

  tracker.start('Search').finish('succeeded');
  tracker.start('Patch').finish('unexpected');

  assert.deepEqual(events.map((event) => event.payload.status), ['running', 'done', 'running', 'failed']);
  assert.deepEqual(events.map((event) => event.payload.text), [
    '调用 Search',
    '调用 Search',
    '调用 Patch',
    '调用 Patch',
  ]);
});
