// Blackboard PoC (FULLY agent-driven) — 黑板里的每条事实,都从真实 agent 的输出里解析出来。
// 流程:真实 agent 产出 → 解析(格式门:解析不出就拒写)→ 确定性闸门落盘(盖来源章+supersede)。
// 与 blackboard-poc.mjs 的区别:那版的事实值是脚本写死的;这版的值全部来自 agent 真实回答。
// 依赖:必须先启动 Agent Cowork(host 3017)。诚实边界:顺序写入+supersede 已验;并发/真值门/4000步=roadmap。
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BASE = 'http://127.0.0.1:3017';
const BB_PATH = join(dirname(fileURLToPath(import.meta.url)), 'blackboard-live.md');
const G='\x1b[32m',R='\x1b[31m',Y='\x1b[33m',C='\x1b[36m',Z='\x1b[0m';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

// ---------- 解析层(格式门:从真实 agent 输出里抽字段;抽不出=拒写)----------
function parsePort(text) { const m = /port[^\d]{0,12}(\d{2,5})/i.exec(text) || /\b(\d{3,5})\b/.exec(text); return m ? m[1] : null; }
function parseDb(text) { const m = /(postgres(?:ql)?|mysql|sqlite|mongodb|redis|mariadb)/i.exec(text); return m ? (/(postgres)/i.test(m[1]) ? 'PostgreSQL' : m[1]) : null; }

// ---------- 确定性写入闸门(单写者;此处没有 LLM)----------
const facts = new Map();   // entity -> { value, agent, ts, quote }
const audit = [];
function gateWrite(agent, entity, value, quote) {
  if (value == null) { audit.push(`[${now()}] [REJECT] ${agent} 的输出解析不出 ${entity},闸门拒绝写入(格式门)`); render(); return false; }
  const prev = facts.get(entity);
  if (prev && prev.value !== value) audit.push(`[${now()}] ${agent} SUPERSEDE ${entity}: ${prev.value} → ${value} | 来源原话:"${quote}" | 旧值(${prev.agent})标记失效`);
  else if (!prev) audit.push(`[${now()}] ${agent} 写入 ${entity}=${value} | 来源原话:"${quote}"`);
  facts.set(entity, { value, agent, ts: now(), quote });
  render(); return true;
}
function logRead(agent, quote) { audit.push(`[${now()}] ${agent} 读取共享黑板 → 真实输出:"${quote}"`); render(); }
function render() {
  const rows = [...facts.entries()].map(([e, f]) => `| ${e} | ${f.value} | ${f.agent} | ${f.ts} | current |`).join('\n');
  writeFileSync(BB_PATH, `# 共享黑板 (Blackboard) — 完全由真实 agent 驱动

> 每条事实都从**真实 agent 的输出**里解析得到(不是脚本写死)。
> 写入路径:真实 agent 产出 → 解析(格式门)→ 确定性闸门落盘(盖来源章 + supersede)。

## 当前事实 (current facts)

| 实体 | 值 | 来源 agent | 时间 (UTC) | 状态 |
|---|---|---|---|---|
${rows}

## 审计链 (每条都带 agent 的真实原话,可回溯)

${audit.map(l => `- ${l}`).join('\n')}

---
_完全 agent 驱动:值全部来自真实 LLM 输出。并发写 / 真值门 / 4000 步 = roadmap。_
`, 'utf8');
}

async function ask(t, conv, prompt) {
  const ac = new AbortController(); const tm = setTimeout(() => ac.abort(), 60000); let text = '';
  try {
    const res = await fetch(BASE + '/api/agent/chat/stream', { method: 'POST', signal: ac.signal, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + t }, body: JSON.stringify({ prompt, conversationId: conv, trustedRoot: 'C:/Users/Administrator', autoApprove: true, maxSteps: 3 }) });
    const rd = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
    while (true) { const { done, value } = await rd.read(); if (done) break; buf += dec.decode(value, { stream: true }); const parts = buf.split('\n\n'); buf = parts.pop() || ''; for (const b of parts) { const evt = (b.split('\n').find(l => l.startsWith('event:')) || '').slice(6).trim(); const d = b.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join(''); if (!d || d === '[DONE]') continue; let j; try { j = JSON.parse(d) } catch { continue } if (evt === 'token' && typeof j.delta === 'string') text += j.delta; if (evt === 'done' && typeof j.text === 'string' && j.text) text = j.text; } }
  } catch (e) { } finally { clearTimeout(tm); }
  return text.trim();
}

(async () => {
  console.log(C + '=== Blackboard PoC (完全真实 agent 驱动)— 黑板内容全部从 agent 真实输出解析 ===' + Z);
  let t = null;
  try { t = (await (await fetch(BASE + '/api/auth/guest', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json()).token; } catch { }
  if (!t) { console.log(R + 'X  host 未启动(3017)。本 demo 必须用真实 agent,请先打开 Agent Cowork 再运行。' + Z); return; }
  const conv = 'blackboard-live-' + Date.now();

  console.log(Y + '\n[Agent A / recorder] 真实记录并回显事实 → 解析 → 落盘' + Z);
  const a = await ask(t, conv, 'You are Agent A (recorder). Record these project facts into memory: deploy port = 8080, database = PostgreSQL. Then echo them back on ONE line exactly: deploy_port=8080; database=PostgreSQL');
  console.log('   A 真实输出: ' + a.slice(0, 160));
  gateWrite('Agent A', 'deploy_port', parsePort(a), a.slice(0, 120));
  gateWrite('Agent A', 'database', parseDb(a), a.slice(0, 120));
  await sleep(2500);

  console.log(Y + '[Agent B / config] 读共享 → 真实生成配置(只读)' + Z);
  const b = await ask(t, conv, 'You are Agent B (config generator). Using the project deploy port and database that were ALREADY decided earlier, output ONE startup config line using those exact values.');
  console.log('   B 真实输出: ' + b.slice(0, 160));
  const shareOK = /8080/.test(b) && /postgres/i.test(b);
  console.log(shareOK ? G + '   [OK] B 通过共享记忆用到了 A 的事实' + Z : R + '   [MISS] B 没拿到 A 的事实' + Z);
  logRead('Agent B', b.slice(0, 120));
  await sleep(1500);

  console.log(Y + '\n[Agent C / corrector] 真实纠正 → 解析新值 → 闸门 supersede' + Z);
  const c = await ask(t, conv, 'You are Agent C (corrector). The deploy port has changed to 9090. Update it in memory. Then output exactly: deploy_port=9090');
  console.log('   C 真实输出: ' + c.slice(0, 160));
  gateWrite('Agent C', 'deploy_port', parsePort(c), c.slice(0, 120));
  await sleep(2500);

  console.log(Y + '[Agent D / verifier] 读当前 deploy_port' + Z);
  const d = await ask(t, conv, 'What is the CURRENT deploy port for this project? Answer the number only.');
  console.log('   D 真实输出: ' + d.slice(0, 80));
  const dPort = parsePort(d);
  const govOK = dPort === '9090';
  console.log(govOK ? G + '   [OK] supersede 生效:D 读到 current=9090(从 D 真实输出解析)' + Z : R + '   [MISS] 纠正没反映' + Z);
  logRead('Agent D', d.slice(0, 80));

  console.log('\n' + C + '黑板已落盘:' + Z + BB_PATH);
  console.log((shareOK && govOK) ? G + '==== GREEN:每条事实都来自真实 agent 输出 + 共享协调 + supersede 治理 ====' + Z : Y + '==== 见上方结果(可能 agent 输出格式有偏差,看审计链是否有 REJECT)====' + Z);
})().catch(e => console.log(R + 'error: ' + (e && e.message) + Z));
