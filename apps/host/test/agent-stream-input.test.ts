import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAgentStreamBody } from '../src/routes/agent-stream-schemas.js';

test('agent stream input schema rejects malformed images before streaming', () => {
  assert.throws(
    () => parseAgentStreamBody({ prompt: 'hello', images: ['image.png', 42] }),
    /agent stream body: images/,
  );
});

test('agent stream input schema keeps known route flags and unknown extension fields', () => {
  const body = parseAgentStreamBody({
    prompt: ' hello ',
    autoApprove: true,
    maxSteps: 3,
    thinking: 'deep',
    planMode: false,
    customExtension: { enabled: true },
  });

  assert.equal(body.prompt, ' hello ');
  assert.equal(body.autoApprove, true);
  assert.equal(body.maxSteps, 3);
  assert.equal(body.thinking, 'deep');
  assert.deepEqual(body.customExtension, { enabled: true });
});
