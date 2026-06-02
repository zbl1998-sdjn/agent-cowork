import assert from 'node:assert/strict';
import test from 'node:test';
import { createProjectStore } from '../src/storage/projects.js';

test('create makes a project and requires a name', () => {
  const store = createProjectStore();
  const p = store.create({ name: '客户 A', color: '#2563eb' });
  assert.equal(p.id, 'proj_1');
  assert.equal(p.name, '客户 A');
  assert.equal(p.archived, false);
  assert.throws(() => store.create({ name: '   ' }), /name is required/);
});

test('rename / setColor / archive / unarchive update the record', () => {
  const store = createProjectStore();
  const p = store.create({ name: 'x' });
  assert.equal(store.rename(p.id, '新名').name, '新名');
  assert.equal(store.setColor(p.id, '#f00').color, '#f00');
  assert.equal(store.archive(p.id).archived, true);
  assert.equal(store.unarchive(p.id).archived, false);
});

test('list can exclude archived projects', () => {
  const store = createProjectStore();
  const a = store.create({ name: 'a' });
  store.create({ name: 'b' });
  store.archive(a.id);
  assert.equal(store.list().length, 2);
  assert.equal(store.list({ includeArchived: false }).length, 1);
});

test('a conversation belongs to at most one project (reassign moves it)', () => {
  const store = createProjectStore();
  const p1 = store.create({ name: 'p1' });
  const p2 = store.create({ name: 'p2' });
  store.assignConversation(p1.id, 'conv_1');
  assert.equal(store.projectOfConversation('conv_1'), p1.id);
  store.assignConversation(p2.id, 'conv_1');
  assert.equal(store.projectOfConversation('conv_1'), p2.id);
  assert.deepEqual(store.conversationsOf(p1.id), []);
  assert.deepEqual(store.conversationsOf(p2.id), ['conv_1']);
});

test('artifact membership and stats count correctly', () => {
  const store = createProjectStore();
  const p = store.create({ name: 'p' });
  store.assignConversation(p.id, 'c1');
  store.assignConversation(p.id, 'c2');
  store.assignArtifact(p.id, 'a1');
  assert.deepEqual(store.stats(p.id), { conversations: 2, artifacts: 1 });
});

test('remove clears the project and its memberships', () => {
  const store = createProjectStore();
  const p = store.create({ name: 'p' });
  store.assignConversation(p.id, 'c1');
  store.assignArtifact(p.id, 'a1');
  assert.equal(store.remove(p.id), true);
  assert.equal(store.get(p.id), null);
  assert.equal(store.projectOfConversation('c1'), null);
  assert.equal(store.remove('proj_999'), false);
});

test('assigning to / renaming an unknown project throws', () => {
  const store = createProjectStore();
  assert.throws(() => store.assignConversation('proj_404', 'c1'), /unknown project/);
  assert.throws(() => store.rename('proj_404', 'x'), /unknown project/);
});
