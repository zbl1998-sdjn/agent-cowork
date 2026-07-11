import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildLiveArtifact,
  refreshLiveArtifactDataAsync,
} from '../src/artifacts/live-artifact.js';
import type { ToolDescriptor, ToolRegistryLike } from '../src/artifacts/live-refresh.js';
import { tempRoot } from './helpers/host-http.js';

const TOOL = 'mcp__demo__read_report';

function registryFor(descriptor: ToolDescriptor): ToolRegistryLike & { calls: number } {
  const registry = {
    calls: 0,
    descriptor: () => descriptor,
    call: () => {
      registry.calls += 1;
      return { viz: { kind: 'table', data: { columns: ['value'], rows: [[1]] } } };
    },
  };
  return registry;
}

test('connector live refresh fails closed on incomplete, risky, or mismatched descriptors', async () => {
  const root = tempRoot('kcw-art-live-connector-auth-');
  const built = buildLiveArtifact({
    trustedRoot: root,
    id: 'viz_connector_auth',
    viz: { kind: 'table', data: { columns: ['value'], rows: [[0]] } },
    dataSource: { type: 'connector-tool', tool: TOOL, args: {} },
  });
  const denied: ToolDescriptor[] = [
    { source: 'mcp:demo', name: TOOL, risk: 'low', mutating: false },
    { source: 'mcp:demo', name: TOOL, risk: 'low', requiresApproval: false },
    { source: 'mcp:demo', name: TOOL, mutating: false, requiresApproval: false },
    { source: 'mcp:demo', name: TOOL, risk: 'medium', mutating: false, requiresApproval: false },
    { source: 'mcp:other', name: TOOL, risk: 'low', mutating: false, requiresApproval: false },
    {
      source: 'mcp:demo',
      name: 'mcp__demo__other',
      risk: 'low',
      mutating: false,
      requiresApproval: false,
    },
  ];

  for (const descriptor of denied) {
    const registry = registryFor(descriptor);
    await assert.rejects(
      () => refreshLiveArtifactDataAsync({
        trustedRoot: root,
        id: built.id,
        toolRegistry: registry,
      }),
      (error: unknown) => (error as { statusCode?: unknown }).statusCode === 403,
    );
    assert.equal(registry.calls, 0, JSON.stringify(descriptor));
  }
});

test('the exact filesystem read connector remains explicitly allowlisted', async () => {
  const root = tempRoot('kcw-art-live-fs-connector-');
  const built = buildLiveArtifact({
    trustedRoot: root,
    id: 'viz_fs_connector',
    viz: { kind: 'table', data: { columns: ['value'], rows: [[0]] } },
    dataSource: { type: 'connector-tool', tool: 'mcp__fs__read_text', args: {} },
  });
  const registry = registryFor({
    source: 'mcp:fs',
    name: 'mcp__fs__read_text',
    risk: 'critical',
    mutating: true,
    requiresApproval: true,
  });

  const data = await refreshLiveArtifactDataAsync({
    trustedRoot: root,
    id: built.id,
    toolRegistry: registry,
  });

  assert.equal(registry.calls, 1);
  assert.equal(data.viz.kind, 'table');
});
