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

test('tool policy classifies WebSearch (and separator variants) as external network', () => {
  // 实际工具名是 WebSearch;此前只匹配 web.fetch/webfetch,漏了它 → air_gap 仍会打 DDG/Bing。
  assert.equal(classifyToolRisk({ toolName: 'WebSearch' }), 'network_external');
  assert.equal(classifyToolRisk({ toolName: 'web.search' }), 'network_external');
  assert.equal(classifyToolRisk({ toolName: 'web_search' }), 'network_external');
});

test('air_gap denies WebSearch external network tool', () => {
  const decision = decideToolPolicy({ securityMode: 'air_gap', toolName: 'WebSearch', risk: 'low' });
  assert.equal(decision.decision, 'deny');
  assert.equal(decision.reasonCode, 'air_gap_blocks_external_network_tool');
});

test('local_strict denies WebSearch external network tool', () => {
  const decision = decideToolPolicy({ securityMode: 'local_strict', toolName: 'WebSearch', risk: 'low' });
  assert.equal(decision.decision, 'deny');
  assert.equal(decision.reasonCode, 'local_strict_blocks_external_network_tool');
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
