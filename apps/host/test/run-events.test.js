import assert from 'node:assert/strict';
import test from 'node:test';
import { RunEventBus, formatSseFrame, parseLastEventId } from '../src/runtime/run-events.js';

test('RunEventBus assigns monotonic seq per run', () => {
  const bus = new RunEventBus();
  const a1 = bus.publish('run_a', { type: 'user_message', text: 'hi' });
  const a2 = bus.publish('run_a', { type: 'progress', text: 'working' });
  const b1 = bus.publish('run_b', { type: 'user_message', text: 'yo' });
  assert.equal(a1.seq, 1);
  assert.equal(a2.seq, 2);
  assert.equal(b1.seq, 1, 'seq is per-run');
  assert.ok(a1.ts);
  assert.equal(a1.type, 'user_message');
});

test('RunEventBus validates inputs', () => {
  const bus = new RunEventBus();
  assert.throws(() => bus.publish('', { type: 'x' }), /runId required/);
  assert.throws(() => bus.publish('r', {}), /event.type required/);
});

test('RunEventBus subscribe receives live events and unsubscribe stops them', () => {
  const bus = new RunEventBus();
  const received = [];
  const unsub = bus.subscribe('run_x', (e) => received.push(e.type));
  bus.publish('run_x', { type: 'a' });
  bus.publish('run_x', { type: 'b' });
  unsub();
  bus.publish('run_x', { type: 'c' });
  assert.deepEqual(received, ['a', 'b']);
  assert.equal(bus.subscriberCount('run_x'), 0);
});

test('RunEventBus replay returns events after a seq', () => {
  const bus = new RunEventBus();
  bus.publish('r', { type: 'a' });
  bus.publish('r', { type: 'b' });
  bus.publish('r', { type: 'c' });
  const after1 = bus.replay('r', 1);
  assert.deepEqual(after1.map((e) => e.type), ['b', 'c']);
  const all = bus.replay('r', 0);
  assert.equal(all.length, 3);
});

test('RunEventBus buffer is bounded', () => {
  const bus = new RunEventBus({ bufferSize: 10 });
  for (let i = 0; i < 25; i += 1) {
    bus.publish('r', { type: 'tick', i });
  }
  const buffered = bus.replay('r', 0);
  assert.equal(buffered.length, 10);
  // Newest preserved, oldest dropped.
  assert.equal(buffered[buffered.length - 1].i, 24);
  assert.equal(buffered[0].i, 15);
});

test('RunEventBus.seed lifts seq above persisted max', () => {
  const bus = new RunEventBus();
  bus.seed('r', [{ seq: 5, type: 'x' }, { seq: 9, type: 'y' }]);
  const next = bus.publish('r', { type: 'z' });
  assert.equal(next.seq, 10);
});

test('formatSseFrame emits id, event, data lines', () => {
  const frame = formatSseFrame({ seq: 7, type: 'progress', text: 'hi' });
  assert.match(frame, /^id: 7\n/);
  assert.match(frame, /event: progress\n/);
  assert.match(frame, /data: \{.*"text":"hi".*\}\n\n$/);
});

test('parseLastEventId parses positive ints, else 0', () => {
  assert.equal(parseLastEventId('5'), 5);
  assert.equal(parseLastEventId(''), 0);
  assert.equal(parseLastEventId(undefined), 0);
  assert.equal(parseLastEventId('-3'), 0);
  assert.equal(parseLastEventId('abc'), 0);
});
