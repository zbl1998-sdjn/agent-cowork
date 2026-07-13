import assert from 'node:assert/strict';
import test from 'node:test';
import * as domainModelBreakers from '../src/engine/model-breakers.js';
import * as runtimeModelBreakers from '../src/runtime/model-breakers.js';
import * as utilRunEvents from '../src/util/run-events.js';
import * as runtimeRunEvents from '../src/runtime/run-events.js';
import * as storageRunStore from '../src/storage/run-store.js';
import * as runtimeRunStore from '../src/runtime/run-store.js';
import * as storageRunsIndex from '../src/storage/runs-index.js';
import * as runtimeRunsIndex from '../src/runtime/runs-index.js';
import * as utilCircuitBreaker from '../src/util/circuit-breaker.js';
import * as runtimeCircuitBreaker from '../src/runtime/circuit-breaker.js';

test('runtime compatibility exports preserve implementation identity after responsibility relocation', () => {
  assert.equal(runtimeCircuitBreaker.CircuitBreaker, utilCircuitBreaker.CircuitBreaker);
  assert.equal(runtimeModelBreakers.modelBreaker, domainModelBreakers.modelBreaker);
  assert.equal(runtimeModelBreakers.modelBreakerStats, domainModelBreakers.modelBreakerStats);
  assert.equal(runtimeRunStore.writeRunRecord, storageRunStore.writeRunRecord);
  assert.equal(runtimeRunStore.readRunRecord, storageRunStore.readRunRecord);
  assert.equal(runtimeRunsIndex.RunsIndex, storageRunsIndex.RunsIndex);
  assert.equal(runtimeRunsIndex.SqliteRunsIndex, storageRunsIndex.SqliteRunsIndex);
  assert.equal(runtimeRunsIndex.summariseRunForIndex, storageRunsIndex.summariseRunForIndex);
  assert.equal(runtimeRunEvents.RunEventBus, utilRunEvents.RunEventBus);
  assert.equal(runtimeRunEvents.formatSseFrame, utilRunEvents.formatSseFrame);
});
