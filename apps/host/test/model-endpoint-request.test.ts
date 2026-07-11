import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo, Server } from 'node:http';
import test from 'node:test';

import {
  createModelEndpointFetch,
  modelAddressScope,
  resolveModelEndpoint,
} from '../src/security/model-endpoint-request.js';

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

test('model endpoint DNS validation rejects private, metadata, and mixed answers for public providers', async () => {
  assert.equal(modelAddressScope('93.184.216.34'), 'public');
  assert.equal(modelAddressScope('10.0.0.4'), 'private');
  assert.equal(modelAddressScope('169.254.169.254'), 'blocked');
  assert.equal(modelAddressScope('fd00::4'), 'private');
  assert.equal(modelAddressScope('fec0::4'), 'private');

  const config = { provider: 'openai', baseUrl: 'https://api.example.test/v1' };
  await assert.rejects(
    () => resolveModelEndpoint('https://api.example.test/v1/chat/completions', config, {
      env: {},
      lookupImpl: async () => [{ address: '10.0.0.4', family: 4 }],
    }),
    /private.*not allowed|blocked/i,
  );
  await assert.rejects(
    () => resolveModelEndpoint('https://api.example.test/v1/chat/completions', config, {
      env: {},
      lookupImpl: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '169.254.169.254', family: 4 },
      ],
    }),
    /blocked/i,
  );
});

test('explicit customer gateway allowlist permits private DNS but never metadata or link-local targets', async () => {
  const env = { KCW_CUSTOMER_MODEL_GATEWAY_HOSTS: '*.gateway.corp' };
  const config = { provider: 'custom-openai-compatible', baseUrl: 'https://east.gateway.corp/v1' };
  const resolved = await resolveModelEndpoint('https://east.gateway.corp/v1/chat/completions', config, {
    env,
    lookupImpl: async () => [{ address: '10.20.30.40', family: 4 }],
  });
  assert.equal(resolved.address, '10.20.30.40');
  assert.equal(resolved.providerClass, 'customer_gateway');

  await assert.rejects(
    () => resolveModelEndpoint('https://east.gateway.corp/v1/chat/completions', config, {
      env,
      lookupImpl: async () => [{ address: '169.254.169.254', family: 4 }],
    }),
    /blocked/i,
  );
});

test('native model request does not follow a redirect to another origin', async () => {
  let redirectedCalls = 0;
  const destination = http.createServer((_request, response) => {
    redirectedCalls += 1;
    response.statusCode = 200;
    response.end('credential sink');
  });
  const destinationPort = await listen(destination);
  const redirector = http.createServer((_request, response) => {
    response.statusCode = 302;
    response.setHeader('location', `http://127.0.0.1:${destinationPort}/steal`);
    response.end('redirect');
  });
  const redirectorPort = await listen(redirector);

  try {
    const baseUrl = `http://127.0.0.1:${redirectorPort}/v1`;
    const fetchModel = createModelEndpointFetch({
      provider: 'openai/local',
      baseUrl,
      securityMode: 'local_strict',
    });
    const response = await fetchModel(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer dummy-local-key' },
      body: '{}',
    });
    assert.equal(response.status, 302);
    assert.equal(response.ok, false);
    assert.equal(await response.text(), 'redirect');
    assert.equal(redirectedCalls, 0);
  } finally {
    await close(redirector);
    await close(destination);
  }
});

test('trusted in-process fetch seams receive redirect:error and unsafe literal URLs are still rejected', async () => {
  let redirectMode = '';
  const fetchModel = createModelEndpointFetch(
    { provider: 'openai', baseUrl: 'https://api.example.test/v1' },
    {
      fetchImpl: async (_url, init = {}) => {
        redirectMode = String(init.redirect || '');
        return {
          ok: true,
          status: 200,
          body: null,
          async json() { return {}; },
          async text() { return ''; },
        };
      },
    },
  );
  await fetchModel('https://api.example.test/v1/chat/completions', { method: 'POST' });
  assert.equal(redirectMode, 'error');

  await assert.rejects(
    () => fetchModel('http://169.254.169.254/latest/meta-data', { method: 'POST' }),
    /configured model base URL|unsafe|metadata/i,
  );
});

test('model address classifier covers reserved IPv4 and IPv6 ranges fail closed', () => {
  const cases = new Map<string, ReturnType<typeof modelAddressScope>>([
    ['', 'blocked'],
    ['999.1.1.1', 'blocked'],
    ['127.0.0.2', 'loopback'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.1.1', 'private'],
    ['100.64.0.1', 'private'],
    ['198.18.0.1', 'private'],
    ['100.100.100.200', 'blocked'],
    ['0.1.2.3', 'blocked'],
    ['224.0.0.1', 'blocked'],
    ['192.0.0.1', 'blocked'],
    ['192.0.2.1', 'blocked'],
    ['198.51.100.1', 'blocked'],
    ['203.0.113.1', 'blocked'],
    ['8.8.8.8', 'public'],
    ['::1', 'loopback'],
    ['::', 'blocked'],
    ['::ffff:127.0.0.1', 'blocked'],
    ['fd00:ec2::254', 'blocked'],
    ['fc00::1', 'private'],
    ['fe80::1', 'blocked'],
    ['ff02::1', 'blocked'],
    ['2001:db8::1', 'blocked'],
    ['2001:4860:4860::8888', 'public'],
  ]);
  for (const [address, expected] of cases) {
    assert.equal(modelAddressScope(address), expected, address);
  }
});

test('model endpoint rejects invalid origins, DNS failures, and provider-scope mismatches', async () => {
  const external = { provider: 'openai', baseUrl: 'https://api.example.test/v1' };
  await assert.rejects(
    () => resolveModelEndpoint('', external, { env: {}, lookupImpl: async () => '93.184.216.34' }),
    /invalid|missing|endpoint/i,
  );
  await assert.rejects(
    () => resolveModelEndpoint('https://other.example.test/v1', external, {
      env: {},
      lookupImpl: async () => '93.184.216.34',
    }),
    /does not match.*origin/i,
  );
  await assert.rejects(
    () => resolveModelEndpoint('https://api.example.test/v1', external, {
      env: {},
      lookupImpl: async () => { throw new Error('resolver down'); },
    }),
    /DNS resolution failed/,
  );
  for (const invalidAnswer of [[], [{}], [{ address: '93.184.216.34', family: 3 }]]) {
    await assert.rejects(
      () => resolveModelEndpoint('https://api.example.test/v1', external, {
        env: {},
        lookupImpl: async () => invalidAnswer,
      }),
      /no usable addresses/,
    );
  }

  const resolved = await resolveModelEndpoint('https://api.example.test/v1', external, {
    env: {},
    lookupImpl: async () => '93.184.216.34',
  });
  assert.equal(resolved.family, 4);

  await assert.rejects(
    () => resolveModelEndpoint('http://127.0.0.1:11434/v1', {
      provider: 'openai/local',
      baseUrl: 'http://127.0.0.1:11434/v1',
      securityMode: 'local_strict',
    }, {
      env: {},
      lookupImpl: async () => '93.184.216.34',
    }),
    /local model endpoint resolved outside loopback/,
  );
  await assert.rejects(
    () => resolveModelEndpoint('https://east.gateway.corp/v1', {
      provider: 'custom-openai-compatible',
      baseUrl: 'https://east.gateway.corp/v1',
    }, {
      env: { KCW_CUSTOMER_MODEL_GATEWAY_HOSTS: '*.gateway.corp' },
      lookupImpl: async () => '127.0.0.1',
    }),
    /customer gateway resolved to loopback/,
  );
});

test('external native model fetch requires an approval receipt before DNS or I/O', async () => {
  let lookups = 0;
  const fetchModel = createModelEndpointFetch(
    {
      provider: 'openai',
      baseUrl: 'https://api.example.test/v1',
      securityMode: 'controlled_hybrid',
    },
    {
      env: {},
      lookupImpl: async () => {
        lookups += 1;
        return '93.184.216.34';
      },
    },
  );
  await assert.rejects(
    () => fetchModel('https://api.example.test/v1/chat/completions'),
    (error) => (
      typeof error === 'object'
      && error !== null
      && 'code' in error
      && error.code === 'EGRESS_APPROVAL_REQUIRED'
    ),
  );
  assert.equal(lookups, 0);
});

test('injected and pinned model responses expose deterministic text and JSON readers', async () => {
  const injected = createModelEndpointFetch(
    { provider: 'openai', baseUrl: 'https://api.example.test/v1' },
    {
      env: {},
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        async json() { return { source: 'injected' }; },
      }),
    },
  );
  const injectedResponse = await injected('https://api.example.test/v1/chat/completions');
  assert.equal(await injectedResponse.text(), '{"source":"injected"}');
  assert.equal(injectedResponse.body, null);

  const server = http.createServer((_request, response) => {
    response.statusCode = 200;
    response.setHeader('content-type', 'application/json');
    response.end('{"source":"pinned"}');
  });
  const port = await listen(server);
  try {
    const baseUrl = 'http://127.0.0.1:' + port + '/v1';
    const pinned = createModelEndpointFetch({
      provider: 'openai/local',
      baseUrl,
      securityMode: 'local_strict',
    });
    const response = await pinned(baseUrl + '/models');
    assert.equal(response.ok, true);
    assert.deepEqual(await response.json(), { source: 'pinned' });
  } finally {
    await close(server);
  }
});
