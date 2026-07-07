// OS 级出网强制:防火墙规则计划(切片 #3)——纯函数、jail、allowlist、命令生成
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildEgressFirewallPlan, EGRESS_FIREWALL_GROUP } from '../src/security/egress-firewall.js';

test('plan blocks outbound per app exe and allows loopback + gateway remotes', () => {
  const plan = buildEgressFirewallPlan({
    appExePaths: ['C:\\Program Files\\Agent Cowork\\agent-cowork-desktop.exe'],
    allowHosts: ['10.0.0.5', '192.168.1.0/24'],
  });
  assert.equal(plan.ruleGroup, EGRESS_FIREWALL_GROUP);
  const actions = plan.rules.map((r) => `${r.action}:${r.name}`);
  assert.ok(plan.rules.some((r) => r.action === 'allow' && /loopback/i.test(r.name)), 'loopback allowed');
  assert.ok(plan.rules.some((r) => r.action === 'allow' && r.remoteAddress === '10.0.0.5'), 'gateway ip allowed');
  assert.ok(plan.rules.some((r) => r.action === 'allow' && r.remoteAddress === '192.168.1.0/24'), 'gateway cidr allowed');
  assert.ok(plan.rules.some((r) => r.action === 'block' && r.program?.includes('agent-cowork-desktop.exe')), 'per-exe outbound block');
  assert.ok(plan.rules.every((r) => r.direction === 'outbound'));
  void actions;
});

test('plan emits reviewable PowerShell New-NetFirewallRule commands scoped to the group', () => {
  const plan = buildEgressFirewallPlan({ appExePaths: ['C:\\x\\app.exe'], allowHosts: [] });
  assert.ok(plan.commands.length >= 2);
  assert.ok(plan.commands.every((c) => c.includes('New-NetFirewallRule') && c.includes(EGRESS_FIREWALL_GROUP)));
  // 撤销命令按 group 一把清,便于回滚
  assert.match(plan.removeCommand, /Remove-NetFirewallRule.*Group.*Agent Cowork Egress Lockdown/);
  assert.equal(plan.executed, false, 'plan never runs anything');
});

test('non-IP gateway hosts are surfaced as needing a DNS pin, not silently allowed', () => {
  const plan = buildEgressFirewallPlan({ appExePaths: ['C:\\x\\app.exe'], allowHosts: ['llm-gateway.corp'] });
  assert.ok(plan.warnings.some((w) => /llm-gateway\.corp/.test(w) && /DNS|解析|pin/i.test(w)));
  // 不把无法静态解析的主机名当成 remoteAddress 放行(防火墙按 IP 判定)
  assert.ok(!plan.rules.some((r) => r.remoteAddress === 'llm-gateway.corp'));
});

test('rejects when no app exe path is provided (nothing to lock down)', () => {
  assert.throws(() => buildEgressFirewallPlan({ appExePaths: [], allowHosts: [] }), /exe/i);
});

test('broad loopback allow warns about local-proxy egress bypass (real-machine finding 2026-07-07)', () => {
  const plan = buildEgressFirewallPlan({ appExePaths: ['C:\\x\\app.exe'], allowHosts: [] });
  assert.ok(plan.warnings.some((w) => /代理|proxy/i.test(w) && /loopback|127\.0\.0/i.test(w)), 'must warn loopback+proxy bypass');
  assert.ok(plan.rules.some((r) => r.action === 'allow' && r.remoteAddress === '127.0.0.0/8' && !r.remotePort), 'broad loopback rule present');
});

test('loopbackAllowPorts narrows loopback allow to the model port (no proxy port left open)', () => {
  const plan = buildEgressFirewallPlan({ appExePaths: ['C:\\x\\app.exe'], allowHosts: [], loopbackAllowPorts: [11434] });
  const loop = plan.rules.find((r) => r.action === 'allow' && r.remoteAddress === '127.0.0.0/8');
  assert.ok(loop, 'loopback allow present');
  assert.equal(loop?.remotePort, '11434', 'loopback allow scoped to model port');
  assert.ok(plan.commands.some((c) => c.includes("-RemotePort '11434'")), 'command carries RemotePort');
  assert.ok(!plan.warnings.some((w) => /未指定 loopbackAllowPorts/.test(w)), 'no broad-loopback warning when scoped');
});
