import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createSandbox } from '../src/sandbox/index.js';
import { normalizeSandboxSpec } from '../src/sandbox/sandbox-spec.js';
import { recordValue, tempRoot } from './helpers/host-http.js';

test('local sandbox does NOT isolate the network (documented limitation, locked by this test)', async () => {
  const srv = http.createServer((_req, res) => { res.end('REACHED'); });
  await new Promise<void>((resolve) => { srv.listen(0, '127.0.0.1', () => resolve()); });
  const address = srv.address();
  assert.ok(address && typeof address === 'object', 'loopback server should bind to a TCP port');
  const { port } = address;
  try {
    const sandbox = createSandbox({ backend: 'local' });
    const code = `const http=require('http');http.get('http://127.0.0.1:${port}/',r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>process.stdout.write(d));}).on('error',e=>process.stdout.write('ERR '+e.message));`;
    const spec = normalizeSandboxSpec(
      { tool: 'node', args: ['-e', code], timeoutMs: 8000, network: false, unrestrictedHostExecution: true },
      { allowTools: ['node'], allowUnrestrictedHostExecution: true },
    );
    const res = recordValue(await sandbox.exec(spec, { trustedRoot: tempRoot('kcw-sbx-') }), 'local sandbox result');
    const warnings = res.warnings;
    assert.equal(res.networkIsolated, false, 'local backend must not claim network isolation');
    assert.ok(Array.isArray(warnings) && warnings.some((warning) => /network/i.test(String(warning))), 'local backend must warn it cannot isolate the network');
    assert.match(String(res.stdout), /REACHED/, 'sandboxed process can reach loopback on the local backend; use the vm backend to truly block it');
  } finally {
    await new Promise<void>((resolve) => { srv.close(() => resolve()); });
  }
});
