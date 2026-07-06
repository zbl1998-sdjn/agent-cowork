import assert from 'node:assert/strict';
import test from 'node:test';
import { errorMessage, errorPayload, errorStatus } from '../src/routes/route-error-utils.js';

test('route error utilities preserve explicit status, message, and payload', () => {
  const error = Object.assign(new Error('sandbox failed'), {
    statusCode: 504,
    payload: { runId: 'run_1', retryable: false },
  });

  assert.equal(errorStatus(error, 400), 504);
  assert.equal(errorMessage(error), 'sandbox failed');
  assert.deepEqual(errorPayload(error), { runId: 'run_1', retryable: false });
});

test('route error utilities fall back for primitive or malformed errors', () => {
  assert.equal(errorStatus('bad request', 422), 422);
  assert.equal(errorMessage('bad request'), 'bad request');
  assert.deepEqual(errorPayload({ payload: 'not-an-object' }), {});
  assert.equal(errorMessage(null), 'request failed');
});
