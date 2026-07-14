// Native sidecar identity proof (host · L3 route helper).
// The secret stays process-local; only a challenge-bound HMAC is returned.
import { createHmac } from 'node:crypto';

import { headerValue, sendJson, type HttpRequestLike, type HttpResponseLike } from '../http/request-utils.js';
import { SECURITY_HEADERS } from '../http/middleware/common.js';

const SECRET_ENV = 'ACW_SIDECAR_SECRET';
const SECRET_ENV_LEGACY = 'KCW_SIDECAR_SECRET';
const CHALLENGE_HEADER = 'x-acw-sidecar-challenge';
const PROOF_HEADER = 'x-acw-sidecar-proof';
const PROOF_CONTEXT = 'agent-cowork-sidecar-health-v1:';
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;

export function handleHealthRoute(request: HttpRequestLike, response: HttpResponseLike): boolean {
  const challengeHex = (headerValue(request, CHALLENGE_HEADER) || '').trim();
  if (!challengeHex) { sendJson(response, 200, { ok: true, service: 'agent-cowork-host' }); return true; }
  if (!SHA256_HEX_PATTERN.test(challengeHex)) {
    sendJson(response, 400, { error: 'invalid sidecar identity challenge' });
    return true;
  }
  const secretHex = String(process.env[SECRET_ENV] || process.env[SECRET_ENV_LEGACY] || '').trim();
  if (!SHA256_HEX_PATTERN.test(secretHex)) {
    response.writeHead(404, SECURITY_HEADERS);
    response.end();
    return true;
  }
  const proof = createHmac('sha256', Buffer.from(secretHex, 'hex'))
    .update(`${PROOF_CONTEXT}${challengeHex}`, 'utf8')
    .digest('hex');
  response.writeHead(200, { ...SECURITY_HEADERS, 'cache-control': 'no-store', [PROOF_HEADER]: proof });
  response.end();
  return true;
}
