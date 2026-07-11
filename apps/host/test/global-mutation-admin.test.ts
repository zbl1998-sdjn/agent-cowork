import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  isGlobalMutationAdmin,
  resolveGlobalMutationAdmins,
} from '../src/auth/global-mutation-admin.js';
import { createServer, type HostServer, type ServerConfig } from '../src/server.js';
import { createSkillRegistry } from '../src/skills/skill-registry.js';
import { bind, close, jsonRequest, tempRoot } from './helpers/host-http.js';

type Identity = { tenantId: string; userId: string };

const CROSS_TENANT_USER = { tenantId: 'tenant_other', userId: 'user_admin' };
const SIBLING_USER = { tenantId: 'tenant_admin', userId: 'user_sibling' };
const LISTED_ADMIN = { tenantId: 'tenant_admin', userId: 'user_admin' };

function identityHeaders(identity: Identity): Record<string, string> {
  return {
    'x-tenant-id': identity.tenantId,
    'x-user-id': identity.userId,
    'x-role': 'admin',
    'x-admin': 'true',
  };
}

async function withServer(
  config: ServerConfig,
  fn: (base: string, server: HostServer) => Promise<void>,
): Promise<void> {
  const server = createServer({
    requireAuth: false,
    trustIdentityHeaders: true,
    persistAuth: false,
    enableScheduler: false,
    ...config,
  });
  const base = await bind(server);
  try {
    await fn(base, server);
  } finally {
    await close(server);
  }
}

function mutationConfig(root: string, overrides: ServerConfig = {}): ServerConfig {
  return {
    trustedRoot: root,
    globalMutationAdmins: [LISTED_ADMIN],
    ...overrides,
  };
}

test('Kimi host config rejects ordinary identities before body parsing or persistence', async () => {
  const root = tempRoot('kcw-global-admin-kimi-');
  await withServer(mutationConfig(root), async (base) => {
    for (const identity of [CROSS_TENANT_USER, SIBLING_USER]) {
      const response = await fetch(`${base}/api/kimi/config?role=admin`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...identityHeaders(identity),
        },
        body: '{',
      });
      assert.equal(response.status, 403, `${identity.tenantId}/${identity.userId} must be denied before invalid JSON is read`);
    }

    const response = await jsonRequest(base, '/api/kimi/config', {
      method: 'POST',
      headers: identityHeaders(SIBLING_USER),
      body: { model: 'must-not-persist' },
    });
    assert.equal(response.status, 403);
    assert.equal(fs.existsSync(path.join(root, '.AgentCowork', 'config.json')), false);
  });
});

test('MCP registry connect and disconnect reject ordinary identities without registry side effects', async () => {
  const root = tempRoot('kcw-global-admin-mcp-');
  let connectCalls = 0;
  let disconnectCalls = 0;
  const toolRegistry = {
    async registerMcpClient() { return 0; },
    mcpServers() { return []; },
    unregisterMcpServer(name: string) {
      disconnectCalls += 1;
      return { name, removed: false, toolsRemoved: 0 };
    },
  };

  await withServer(mutationConfig(root, {
    toolRegistry: toolRegistry as NonNullable<ServerConfig['toolRegistry']>,
  }), async (base, server) => {
    server.connectMcpServers = async () => {
      connectCalls += 1;
      return { clients: [], errors: [], toolCount: 1 };
    };

    const connect = await jsonRequest(base, '/api/connectors/connect?role=admin', {
      method: 'POST',
      headers: identityHeaders(CROSS_TENANT_USER),
      body: { id: 'filesystem', trustedRoot: root },
    });
    assert.equal(connect.status, 403);

    const disconnect = await jsonRequest(base, '/api/connectors/disconnect', {
      method: 'POST',
      headers: identityHeaders(SIBLING_USER),
      body: { id: 'filesystem' },
    });
    assert.equal(disconnect.status, 403);
    assert.equal(connectCalls, 0);
    assert.equal(disconnectCalls, 0);
  });
});

test('skill enabled state rejects ordinary identities without toggling', async () => {
  const root = tempRoot('kcw-global-admin-skill-');
  const skillRegistry = createSkillRegistry();
  await withServer(mutationConfig(root, { skillRegistry }), async (base) => {
    const response = await jsonRequest(base, '/api/skills/contract-summary/toggle?role=admin', {
      method: 'POST',
      headers: identityHeaders(SIBLING_USER),
      body: { enabled: false, role: 'admin' },
    });
    assert.equal(response.status, 403);
    assert.equal(skillRegistry.isEnabled('contract-summary'), true);
  });
});

test('purge and retention reject ordinary identities before parsing and leave host data untouched', async () => {
  const root = tempRoot('kcw-global-admin-purge-');
  const oldFile = path.join(root, '.AgentCowork', 'conversations', 'tenant', 'user', 'old.json');
  fs.mkdirSync(path.dirname(oldFile), { recursive: true });
  fs.writeFileSync(oldFile, '{}', 'utf8');

  await withServer(mutationConfig(root), async (base) => {
    const plan = await jsonRequest(base, '/api/security/data/purge-plan', {
      method: 'POST',
      headers: identityHeaders(SIBLING_USER),
      body: { scope: 'content' },
    });
    assert.equal(plan.status, 200, 'the read-only purge plan remains available');

    const purge = await fetch(`${base}/api/security/data/purge?role=admin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...identityHeaders(CROSS_TENANT_USER) },
      body: '{',
    });
    assert.equal(purge.status, 403, 'purge must deny before parsing invalid JSON');

    const confirmedPurge = await jsonRequest(base, '/api/security/data/purge', {
      method: 'POST',
      headers: identityHeaders(SIBLING_USER),
      body: { scope: 'content', confirm: true, role: 'admin' },
    });
    assert.equal(confirmedPurge.status, 403);

    const retention = await jsonRequest(base, '/api/security/data/retention', {
      method: 'POST',
      headers: identityHeaders(SIBLING_USER),
      body: { maxAgeDays: 1 },
    });
    assert.equal(retention.status, 403);
    assert.equal(fs.existsSync(oldFile), true);
  });
});

test('default local identity remains admin while an explicit exact tuple allowlist replaces that default', async () => {
  const localRoot = tempRoot('kcw-global-admin-local-');
  await withServer({ trustedRoot: localRoot }, async (base) => {
    const response = await jsonRequest(base, '/api/skills/contract-summary/toggle', {
      method: 'POST',
      body: { enabled: false },
    });
    assert.equal(response.status, 200);
  });

  const configuredRoot = tempRoot('kcw-global-admin-listed-');
  await withServer(mutationConfig(configuredRoot), async (base) => {
    const local = await jsonRequest(base, '/api/skills/contract-summary/toggle', {
      method: 'POST',
      body: { enabled: false },
    });
    assert.equal(local.status, 403, 'an explicit allowlist replaces the local default');

    const listed = await jsonRequest(base, '/api/skills/contract-summary/toggle', {
      method: 'POST',
      headers: identityHeaders(LISTED_ADMIN),
      body: { enabled: false },
    });
    assert.equal(listed.status, 200);
  });
});

test('Bearer-authenticated users cannot self-assert admin while an exact allowlisted bearer identity can mutate', async () => {
  const root = tempRoot('kcw-global-admin-bearer-');
  const authStore = {
    resolveToken(token: string) {
      if (token === 'test-listed-admin-token') return LISTED_ADMIN;
      if (token === 'test-ordinary-user-token') return SIBLING_USER;
      return null;
    },
  };
  await withServer(mutationConfig(root, {
    authStore,
    requireAuth: true,
    trustIdentityHeaders: false,
  }), async (base) => {
    const ordinary = await jsonRequest(base, '/api/skills/contract-summary/toggle?role=admin', {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-ordinary-user-token',
        'x-role': 'admin',
        'x-admin': 'true',
      },
      body: { enabled: false, role: 'admin' },
    });
    assert.equal(ordinary.status, 403);

    const admin = await jsonRequest(base, '/api/skills/contract-summary/toggle', {
      method: 'POST',
      headers: { authorization: 'Bearer test-listed-admin-token' },
      body: { enabled: false },
    });
    assert.equal(admin.status, 200);
  });
});

test('global mutation admin env accepts exact tuples and malformed config fails closed at startup', async () => {
  const key = 'KCW_GLOBAL_MUTATION_ADMINS';
  const previous = process.env[key];
  try {
    process.env[key] = JSON.stringify([LISTED_ADMIN]);
    await withServer({ trustedRoot: tempRoot('kcw-global-admin-env-') }, async (base) => {
      const listed = await jsonRequest(base, '/api/skills/contract-summary/toggle', {
        method: 'POST',
        headers: identityHeaders(LISTED_ADMIN),
        body: { enabled: false },
      });
      assert.equal(listed.status, 200);
      const sibling = await jsonRequest(base, '/api/skills/contract-summary/toggle', {
        method: 'POST',
        headers: identityHeaders(SIBLING_USER),
        body: { enabled: true },
      });
      assert.equal(sibling.status, 403);
    });

    for (const malformed of [
      'not-json',
      JSON.stringify([{ userId: 'user_admin' }]),
      JSON.stringify([{ tenantId: 'tenant_admin', userId: 'user_admin', role: 'admin' }]),
    ]) {
      process.env[key] = malformed;
      assert.throws(
        () => createServer({ trustedRoot: tempRoot('kcw-global-admin-invalid-env-'), persistAuth: false, enableScheduler: false }),
        /KCW_GLOBAL_MUTATION_ADMINS|global mutation admin/i,
      );
    }
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = previous;
  }

  assert.throws(
    () => createServer({
      trustedRoot: tempRoot('kcw-global-admin-invalid-config-'),
      persistAuth: false,
      enableScheduler: false,
      globalMutationAdmins: [{ userId: 'user_only' }] as unknown as NonNullable<ServerConfig['globalMutationAdmins']>,
    }),
    /tenantId|global mutation admin/i,
  );
});

test('global mutation admin parsing rejects proxies without invoking user-controlled traps', () => {
  const allowlistTraps = { get: 0, getOwnPropertyDescriptor: 0, getPrototypeOf: 0, ownKeys: 0 };
  const allowlist = new Proxy([LISTED_ADMIN], {
    get(target, key, receiver) {
      allowlistTraps.get += 1;
      return Reflect.get(target, key, receiver);
    },
    getOwnPropertyDescriptor(target, key) {
      allowlistTraps.getOwnPropertyDescriptor += 1;
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
    getPrototypeOf(target) {
      allowlistTraps.getPrototypeOf += 1;
      return Reflect.getPrototypeOf(target);
    },
    ownKeys(target) {
      allowlistTraps.ownKeys += 1;
      return Reflect.ownKeys(target);
    },
  });
  assert.throws(() => resolveGlobalMutationAdmins(allowlist), /global mutation admin/i);
  assert.deepEqual(allowlistTraps, { get: 0, getOwnPropertyDescriptor: 0, getPrototypeOf: 0, ownKeys: 0 });

  const configuredTraps = { get: 0, getOwnPropertyDescriptor: 0, getPrototypeOf: 0, ownKeys: 0 };
  const configured = new Proxy({ tenantId: 'tenant_admin', userId: 'user_admin' }, {
    get(target, key, receiver) {
      configuredTraps.get += 1;
      return Reflect.get(target, key, receiver);
    },
    getOwnPropertyDescriptor(target, key) {
      configuredTraps.getOwnPropertyDescriptor += 1;
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
    getPrototypeOf(target) {
      configuredTraps.getPrototypeOf += 1;
      return Reflect.getPrototypeOf(target);
    },
    ownKeys(target) {
      configuredTraps.ownKeys += 1;
      return Reflect.ownKeys(target);
    },
  });
  assert.throws(
    () => resolveGlobalMutationAdmins([configured]),
    /global mutation admin/i,
  );
  assert.deepEqual(configuredTraps, { get: 0, getOwnPropertyDescriptor: 0, getPrototypeOf: 0, ownKeys: 0 });

  const requestTraps = { get: 0, getOwnPropertyDescriptor: 0, getPrototypeOf: 0, ownKeys: 0 };
  const requestContext = new Proxy({ tenantId: 'tenant_admin', userId: 'user_admin' }, {
    get(target, key, receiver) {
      requestTraps.get += 1;
      return Reflect.get(target, key, receiver);
    },
    getOwnPropertyDescriptor(target, key) {
      requestTraps.getOwnPropertyDescriptor += 1;
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
    getPrototypeOf(target) {
      requestTraps.getPrototypeOf += 1;
      return Reflect.getPrototypeOf(target);
    },
    ownKeys(target) {
      requestTraps.ownKeys += 1;
      return Reflect.ownKeys(target);
    },
  });
  assert.equal(
    isGlobalMutationAdmin(requestContext, [LISTED_ADMIN]),
    false,
  );
  assert.deepEqual(requestTraps, { get: 0, getOwnPropertyDescriptor: 0, getPrototypeOf: 0, ownKeys: 0 });
});

test('global mutation admin parsing never invokes array accessors or overridden methods', () => {
  let mapGetterCalls = 0;
  const mapAccessor = [LISTED_ADMIN];
  Object.defineProperty(mapAccessor, 'map', {
    configurable: true,
    enumerable: true,
    get() {
      mapGetterCalls += 1;
      throw new Error('must not execute array map getter');
    },
  });
  assert.throws(() => resolveGlobalMutationAdmins(mapAccessor), /global mutation admin/i);
  assert.equal(mapGetterCalls, 0);

  let indexGetterCalls = 0;
  const indexAccessor = [LISTED_ADMIN];
  Object.defineProperty(indexAccessor, '0', {
    configurable: true,
    enumerable: true,
    get() {
      indexGetterCalls += 1;
      throw new Error('must not execute array index getter');
    },
  });
  assert.throws(() => resolveGlobalMutationAdmins(indexAccessor), /global mutation admin/i);
  assert.equal(indexGetterCalls, 0);
});
