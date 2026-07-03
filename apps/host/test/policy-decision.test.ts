import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyToolRisk, decideToolPolicy } from '../src/security/policy-decision.js';

test('tool policy classifies known high-risk and external tools', () => {
  assert.equal(classifyToolRisk({ toolName: 'Read' }), 'read_workspace');
  assert.equal(classifyToolRisk({ toolName: 'Write', mutating: true }), 'write_workspace');
  assert.equal(classifyToolRisk({ toolName: 'Shell', risk: 'high' }), 'sandbox_exec');
  assert.equal(classifyToolRisk({ toolName: 'web.fetch' }), 'network_external');
  assert.equal(classifyToolRisk({ toolName: 'mcp__github__create_issue' }), 'connector');
});

test('local strict blocks external network tools', () => {
  const decision = decideToolPolicy({
    securityMode: 'local_strict',
    toolName: 'WebFetch',
    risk: 'safe',
  });

  assert.equal(decision.decision, 'deny');
  assert.equal(decision.reasonCode, 'local_strict_blocks_external_network_tool');
});

test('local strict blocks shell when sandbox is not network isolated', () => {
  const decision = decideToolPolicy({
    securityMode: 'local_strict',
    toolName: 'Shell',
    risk: 'high',
    sandbox: { backend: 'local-subprocess', networkIsolated: false },
  });

  assert.equal(decision.decision, 'deny');
  assert.equal(decision.reasonCode, 'local_strict_requires_isolated_sandbox');
});

test('local strict allows shell through a network-isolated sandbox but still requires approval', () => {
  const decision = decideToolPolicy({
    securityMode: 'local_strict',
    toolName: 'Shell',
    risk: 'high',
    sandbox: { backend: 'vm:docker', networkIsolated: true },
  });

  assert.equal(decision.decision, 'needs_approval');
  assert.equal(decision.reasonCode, 'tool_requires_approval');
});
