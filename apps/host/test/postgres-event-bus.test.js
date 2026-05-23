import assert from 'node:assert/strict';
import test from 'node:test';
import { PostgresEventBus } from '../src/storage/postgres-event-bus.js';

function mockCluster() {
  const listeners = new Set();
  function makeClient() {
    return {
      async query(text, params = []) {
        const t = text.replace(/\s+/g, ' ').trim();
        if (t.startsWith('SELECT pg_notify')) { for (const h of listeners) h({ channel: params[0], payload: params[1] }); return { rows: [] }; }
        return { rows: [] };
      },
      on(evt, h) { if (evt === 'notification') listeners.add(h); },
    };
  }
  return { makeClient };
}

test('cross-instance SSE: an event published on B reaches a subscriber on A', async () => {
  const cluster = mockCluster();
  const A = new PostgresEventBus({ client: cluster.makeClient() });
  const B = new PostgresEventBus({ client: cluster.makeClient() });
  await A.start();
  await B.start();
  const received = [];
  A.subscribe('run-1', (e) => received.push(e));
  await B.publish('run-1', { type: 'token', delta: '你好' });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(received.length, 1, 'A received the event B published');
  assert.equal(received[0].type, 'token');
  assert.equal(received[0].delta, '你好');
});

test('published event is delivered exactly once to a same-instance subscriber', async () => {
  const cluster = mockCluster();
  const A = new PostgresEventBus({ client: cluster.makeClient() });
  await A.start();
  const got = [];
  A.subscribe('run-2', (e) => got.push(e));
  await A.publish('run-2', { type: 'done', text: 'ok' });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(got.length, 1, 'no double-delivery (NOTIFY round-trip only)');
});

test('replay returns events the instance has observed', async () => {
  const cluster = mockCluster();
  const A = new PostgresEventBus({ client: cluster.makeClient() });
  await A.start();
  await A.publish('run-3', { type: 'token', delta: 'a' });
  await A.publish('run-3', { type: 'token', delta: 'b' });
  await new Promise((r) => setTimeout(r, 5));
  const events = A.replay('run-3', 0);
  assert.equal(events.length, 2);
});
