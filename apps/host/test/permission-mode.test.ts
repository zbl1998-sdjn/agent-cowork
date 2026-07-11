import assert from 'node:assert/strict';
import test from 'node:test';
import { resolvePermissionMode, shouldAutoApproveLowRisk } from '../src/security/permission-mode.js';

test('permission mode resolves explicit modes and legacy flags', () => {
  assert.equal(resolvePermissionMode({ permissionMode: 'guarded_auto' }), 'guarded_auto');
  assert.equal(resolvePermissionMode({ permissionMode: 'plan' }), 'plan');
  assert.equal(resolvePermissionMode({ autoApprove: true }), 'guarded_auto');
  assert.equal(resolvePermissionMode({ planMode: true, autoApprove: true }), 'plan');
  assert.equal(shouldAutoApproveLowRisk('guarded_auto'), true);
});

test('permission mode fails closed for unknown values', () => {
  assert.equal(resolvePermissionMode({ permissionMode: 'skip_all', autoApprove: true }), 'manual');
  assert.equal(resolvePermissionMode(null), 'manual');
  assert.equal(shouldAutoApproveLowRisk('manual'), false);
  assert.equal(shouldAutoApproveLowRisk('plan'), false);
});
