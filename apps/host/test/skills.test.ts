import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { AddressInfo, Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createSkillRegistry } from '../src/skills/skill-registry.js';
import { createServer } from '../src/server.js';
import { closeTestServer } from './helpers/close-server.js';
import type { SkillDescriptor } from '../src/skills/skill-registry.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-skill-')); }

type JsonRequestOptions = {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function skillArray(value: unknown): SkillDescriptor[] {
  assert.ok(Array.isArray(value), 'expected skills array');
  return value as SkillDescriptor[];
}

async function bind(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object', 'test server should bind to a TCP port');
  return `http://127.0.0.1:${(address as AddressInfo).port}`;
}

async function J(base: string, route: string, opt: JsonRequestOptions = {}): Promise<{ status: number; body: unknown }> {
  const init: RequestInit = {
    headers: { 'content-type': 'application/json', ...(opt.headers || {}) },
    method: opt.method || 'GET',
  };
  if (opt.body !== undefined) {
    init.body = JSON.stringify(opt.body);
  }
  const res = await fetch(`${base}${route}`, init);
  const t = await res.text();
  return { status: res.status, body: t ? JSON.parse(t) as unknown : null };
}

test('skill registry exposes recipe manifests with enabled state', () => {
  const reg = createSkillRegistry();
  const skills = reg.list();
  assert.equal(skills.length, 8);
  const meeting = skills.find((s) => s.id === 'meeting-actions');
  assert.ok(meeting, 'meeting-actions skill should exist');
  assert.ok(meeting.trigger.includes('会议'));
  assert.ok(Array.isArray(meeting.permissions) && meeting.permissions.length > 0);
  assert.equal(meeting.enabled, true);
});

test('skill registry supports injected recipes, fallback manifests, and initial disabled ids', () => {
  const reg = createSkillRegistry({
    recipes: [
      { id: 'custom-audit-pack', name: 'Audit Pack', description: 'Build an audit pack' },
      { id: 'email-draft', name: 'Email Draft' },
    ],
    initialDisabled: ['custom-audit-pack'],
  });

  const custom = reg.get('custom-audit-pack');
  assert.ok(custom, 'custom skill should exist');
  assert.deepEqual(custom.trigger, ['custom', 'audit', 'pack']);
  assert.deepEqual(custom.permissions, ['read-files', 'write-files']);
  assert.deepEqual(custom.outputs, ['plan']);
  assert.equal(custom.description, 'Build an audit pack');
  assert.equal(custom.enabled, false);
  assert.equal(reg.isEnabled('custom-audit-pack'), false);
  assert.equal(reg.get('missing'), null);

  const known = reg.get('email-draft');
  assert.ok(known, 'known skill should exist');
  assert.deepEqual(known.permissions, ['read-files']);
  assert.equal(reg.enabledSkills().map((skill) => skill.id).join(','), 'email-draft');
});

test('setEnabled toggles and reflects in list; unknown id throws 404', () => {
  const reg = createSkillRegistry();
  reg.setEnabled('email-draft', false);
  assert.equal(reg.isEnabled('email-draft'), false);
  assert.equal(reg.enabledSkills().some((s) => s.id === 'email-draft'), false);
  reg.setEnabled('email-draft', true);
  assert.equal(reg.isEnabled('email-draft'), true);
  assert.throws(() => reg.setEnabled('ghost', false), (error) => {
    assert.ok(error instanceof Error);
    assert.equal((error as Error & { statusCode?: unknown }).statusCode, 404);
    return true;
  });
});

test('GET /api/skills + POST /api/skills/:id/toggle', async () => {
  const server = createServer({ trustedRoot: tmp(), enableScheduler: false });
  const base = await bind(server);
  try {
    const list = await J(base, '/api/skills');
    const listBody = isRecord(list.body) ? list.body : {};
    assert.equal(list.status, 200);
    assert.equal(skillArray(listBody.skills).length, 8);

    const off = await J(base, '/api/skills/contract-summary/toggle', { method: 'POST', body: { enabled: false } });
    const offBody = isRecord(off.body) ? off.body : {};
    const offSkill = isRecord(offBody.skill) ? offBody.skill : {};
    assert.equal(off.status, 200);
    assert.equal(offSkill.enabled, false);

    const after = await J(base, '/api/skills');
    const afterBody = isRecord(after.body) ? after.body : {};
    const contractSummary = skillArray(afterBody.skills).find((s) => s.id === 'contract-summary');
    assert.ok(contractSummary, 'contract-summary skill should exist');
    assert.equal(contractSummary.enabled, false);

    const flip = await J(base, '/api/skills/contract-summary/toggle', { method: 'POST', body: {} });
    const flipBody = isRecord(flip.body) ? flip.body : {};
    assert.equal(isRecord(flipBody.skill) ? flipBody.skill.enabled : undefined, true);

    const sanitized = await J(base, '/api/skills/contract-summary/toggle', { method: 'POST', body: { enabled: 'false' } });
    const sanitizedBody = isRecord(sanitized.body) ? sanitized.body : {};
    assert.equal(sanitized.status, 200);
    assert.equal(isRecord(sanitizedBody.skill) ? sanitizedBody.skill.enabled : undefined, false);

    const bad = await J(base, '/api/skills/ghost/toggle', { method: 'POST', body: { enabled: false } });
    assert.equal(bad.status, 404);
  } finally {
    await closeTestServer(server);
  }
});
