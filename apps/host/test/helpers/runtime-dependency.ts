import assert from 'node:assert/strict';
import type {
  RuntimeDependencyStatus,
  RuntimeDependencyStatusItem,
  RuntimeDependencyStatusOptions,
} from '../../src/runtime/dependencies.js';
import { stringField } from './host-http.js';

export type RuntimeSpawnSync = NonNullable<RuntimeDependencyStatusOptions['spawnSync']>;

export function dependencyById(status: RuntimeDependencyStatus, id: string): RuntimeDependencyStatusItem {
  const dependency = status.dependencies.find((item) => item.id === id);
  assert.ok(dependency, `${id} dependency should exist`);
  return dependency;
}

export function recordById(records: Array<Record<string, unknown>>, id: string, label = 'record'): Record<string, unknown> {
  const record = records.find((item) => item.id === id);
  assert.ok(record, `${label} ${id} should exist`);
  return record;
}

export function stringIds(records: Array<Record<string, unknown>>): string[] {
  return records.map((item, index) => stringField(item, 'id', `record[${index}].id`));
}
