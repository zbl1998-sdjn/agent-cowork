import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createSkillRegistry } from '../src/skills/skill-registry.js';
import { createServer } from '../src/server.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-skill-')); }
async function bind(server) { await new Promise((r) => server.listen(0, '127.0.0.1', r)); return `http://127.0.0.1:${server.address().port}`; }
async function J(base, route, opt = {}) {
  const res = await fetch(`${base}${route}`, { headers: { 'content-type': 'application/json', ...(opt.headers || {}) }, method: opt.method || 'GET', body: opt.body ? JSON.stringify(opt.body) : undefined });
  const t = await res.text();
  return { status: res.status, body: t ? JSON.parse(t) : null };
}

test('skill registry exposes recipe manifests with enabled state', () => {
  const reg = createSkillRegistry();
  const skills = reg.list();
  assert.equal(skills.length, 8);
  const meeting = skills.find((s) => s.id === 'meeting-actions');
  assert.ok(meeting.trigger.includes('会议'));
  assert.ok(Array.isArray(meeting.permissions) && meeting.permissions.length > 0);
  assert.equal(meeting.enabled, true);
});

test('setEnabled toggles and reflects in list; unknown id throws 404', () => {
  const reg = createSkillRegistry();
  reg.setEnabled('email-draft', false);
  assert.equal(reg.isEnabled('email-draft'), false);
  assert.equal(reg.enabledSkills().some((s) => s.id === 'email-draft'), false);
  reg.setEnabled('email-draft', true);
  assert.equal(reg.isEnabled('email-draft'), true);
  assert.throws(() => reg.setEnabled('ghost', false), (e) => { assert.equal(e.statusCode, 404); return true; });
});

test('GET /api/skills + POST /api/skills/:id/toggle', async () => {
  const server = createServer({ trustedRoot: tmp(), enableScheduler: false });
  const base = await bind(server);
  try {
    const list = await J(base, '/api/skills');
    assert.equal(list.status, 200);
    assert.equal(list.body.skills.length, 8);

    const off = await J(base, '/api/skills/contract-summary/toggle', { method: 'POST', body: { enabled: false } });
    assert.equal(off.status, 200);
    assert.equal(off.body.skill.enabled, false);

    const after = await J(base, '/api/skills');
    assert.equal(after.body.skills.find((s) => s.id === 'contract-summary').enabled, false);

    const flip = await J(base, '/api/skills/contract-summary/toggle', { method: 'POST', body: {} });
    assert.equal(flip.body.skill.enabled, true);

    const bad = await J(base, '/api/skills/ghost/toggle', { method: 'POST', body: { enabled: false } });
    assert.equal(bad.status, 404);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
