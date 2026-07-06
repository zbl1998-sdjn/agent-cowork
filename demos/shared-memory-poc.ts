// Shared-Memory PoC — two agent roles coordinate through ONE shared MASE memory thread
// (blackboard primitive) + supersede governance. Minimal; concurrency/poisoning/4000-step = roadmap.
const BASE = 'http://127.0.0.1:3017';
const G = '\x1b[32m';
const R = '\x1b[31m';
const Y = '\x1b[33m';
const C = '\x1b[36m';
const Z = '\x1b[0m';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

async function ask(token: string, conversationId: string, prompt: string): Promise<string> {
  const ac = new AbortController();
  const tm = setTimeout(() => ac.abort(), 60000);
  let text = '';
  try {
    const res = await fetch(`${BASE}/api/agent/chat/stream`, {
      method: 'POST',
      signal: ac.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        prompt,
        conversationId,
        trustedRoot: 'C:/Users/Administrator',
        autoApprove: true,
        maxSteps: 3,
      }),
    });
    if (!res.body) return text.trim();
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() || '';
      for (const block of parts) {
        const event = (block.split('\n').find((line) => line.startsWith('event:')) || '').slice(6).trim();
        const data = block
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('');
        if (!data || data === '[DONE]') continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }
        if (!isRecord(parsed)) continue;
        if (event === 'token' && typeof parsed.delta === 'string') text += parsed.delta;
        if (event === 'done' && typeof parsed.text === 'string' && parsed.text) text = parsed.text;
      }
    }
  } catch {
    // This demo prints its own MISS/host-down state; network failures are expected while host is offline.
  } finally {
    clearTimeout(tm);
  }
  return text.trim();
}

async function guestToken(): Promise<string | undefined> {
  try {
    const res = await fetch(`${BASE}/api/auth/guest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const payload = await res.json() as unknown;
    return isRecord(payload) && typeof payload.token === 'string' ? payload.token : undefined;
  } catch {
    return undefined;
  }
}

(async () => {
  console.log(`${C}=== Shared-Memory PoC: agents coordinating via ONE shared MASE memory (blackboard) ===${Z}`);
  const token = await guestToken();
  if (!token) {
    console.log(`${R}X  Host not up (3017). Launch Agent Cowork via desktop shortcut first.${Z}`);
    return;
  }

  const conversationId = `shared-poc-${Date.now()}`;
  console.log(`${Y}\n[Agent A / Recorder] writing project facts into shared memory...${Z}`);
  await ask(token, conversationId, 'You are Agent A (recorder). Record these project facts: deploy port is 8080, database is PostgreSQL. Reply only "recorded".');
  await sleep(2500);

  console.log(`${Y}[Agent B / Config] reading shared memory, building on Agent A...${Z}`);
  const b = await ask(token, conversationId, 'You are Agent B (config generator). Using the project deploy port and database that were ALREADY decided earlier, output ONE startup config line using those exact values.');
  console.log(`   B says: ${b.slice(0, 160)}`);
  const shareOK = /8080/.test(b) && /postgres/i.test(b);
  console.log(shareOK ? `${G}   [OK] B used A's facts via shared memory (8080 + PostgreSQL)${Z}` : `${R}   [MISS] B did not pick up A's facts${Z}`);

  await sleep(1500);
  console.log(`${Y}\n[Agent C / Corrector] correcting a shared fact (supersede)...${Z}`);
  await ask(token, conversationId, 'You are Agent C. Correction: the deploy port is now 9090, not 8080. Reply only "updated".');
  await sleep(2500);

  console.log(`${Y}[Agent D / Verifier] re-reading the CURRENT shared fact...${Z}`);
  const d = await ask(token, conversationId, 'What is the CURRENT deploy port for this project? Answer the number only.');
  console.log(`   D says: ${d.slice(0, 80)}`);
  const govOK = /9090/.test(d) && !/8080/.test(d);
  console.log(govOK ? `${G}   [OK] supersede governance: current=9090, old 8080 overridden${Z}` : `${R}   [MISS] correction not reflected${Z}`);
  console.log(`\n${shareOK && govOK ? `${G}==== GREEN: agents coordinated through shared MASE memory + supersede governance ====${Z}` : `${Y}==== see results above ====${Z}`}`);
  console.log('Note: minimal blackboard primitive (sequential, one shared thread). Concurrency / poisoning / 4000-step = roadmap.');
})().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.log(`${R}error: ${message}${Z}`);
});
