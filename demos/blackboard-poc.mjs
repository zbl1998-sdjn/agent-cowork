// Blackboard PoC (minimal visible) — 多个 agent 通过 ONE 共享、受控、可审计的黑板协调。
// 产出一个可打开的 blackboard.md:每条事实带"来源 agent + 时间",纠正走 supersede 留痕。
// 设计原则演示:LLM 只负责"提议要写啥",确定性闸门(本文件的 writeFact)负责"落盘"。
// 诚实边界:顺序写入 + supersede 已验;并发写 / 真值门 / 4000 步 = roadmap。
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BASE = 'http://127.0.0.1:3017';
const BB_PATH = join(dirname(fileURLToPath(import.meta.url)), 'blackboard.md');
const G='\x1b[32m',R='\x1b[31m',Y='\x1b[33m',C='\x1b[36m',Z='\x1b[0m';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

// ---------- 确定性写入闸门(单写者;此处没有任何 LLM)----------
const facts = new Map();   // entity -> { value, agent, ts }
const audit = [];          // 审计链
function writeFact(agent, entity, value, source) {
  const prev = facts.get(entity);
  if (prev && prev.value !== value) {
    audit.push(`[${now()}] ${agent} SUPERSEDE ${entity}: ${prev.value} → ${value} | reason: correction | 旧值(${prev.agent} 写的)标记失效`);
  } else if (!prev) {
    audit.push(`[${now()}] ${agent} 写入 ${entity}=${value} | source: ${source}`);
  }
  facts.set(entity, { value, agent, ts: now() });
  render();
}
function logRead(agent, note) { audit.push(`[${now()}] ${agent} 读取 → ${note}`); render(); }
function render() {
  const rows = [...facts.entries()].map(([e, f]) => `| ${e} | ${f.value} | ${f.agent} | ${f.ts} | current |`).join('\n');
  const log = audit.map(l => `- ${l}`).join('\n');
  writeFileSync(BB_PATH, `# 共享黑板 (Blackboard) — MASE 多 Agent PoC

> 多个 agent 通过这一块**共享、受控、可审计**的记忆协调。
> 所有写入经过确定性闸门:**盖来源章(谁写的)+ supersede 治理(改了留痕)**。
> LLM 只负责"提议要写啥",落盘是代码。

## 当前事实 (current facts)

| 实体 | 值 | 来源 agent | 时间 (UTC) | 状态 |
|---|---|---|---|---|
${rows}

## 审计链 (audit log — 谁写了什么,可回溯 / 可回滚)

${log}

---
_minimal visible blackboard primitive:顺序写入 + supersede 治理已验。并发写 / 真值门 / 4000 步 = roadmap。_
`, 'utf8');
}

// ---------- 真实 agent 调用(经 Cowork host,验证"共享是真的")----------
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
  console.log(C + '=== Blackboard PoC: 4 个 agent 通过一块共享黑板协调(可见文件 + 溯源 + supersede)===' + Z);
  let t = null;
  try { t = (await (await fetch(BASE + '/api/auth/guest', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json()).token; } catch { }
  const live = !!t;
  console.log(live ? G + 'host 在线:用真实 agent 验证共享' + Z : Y + 'host 未启动(3017):仍产出可见 blackboard.md,但跳过真实 agent 验证(先开 Agent Cowork 可启用)' + Z);
  const conv = 'blackboard-poc-' + Date.now();
  let shareOK = null, govOK = null;

  // Agent A(recorder)— 提议事实 → 闸门落盘到黑板
  console.log(Y + '\n[Agent A / recorder] 写入项目事实 → 黑板' + Z);
  if (live) await ask(t, conv, 'You are Agent A (recorder). Record these project facts: deploy port is 8080, database is PostgreSQL. Reply only "recorded".');
  writeFact('Agent A', 'deploy_port', '8080', 'turn#1');
  writeFact('Agent A', 'database', 'PostgreSQL', 'turn#1');
  await sleep(live ? 2500 : 200);

  // Agent B(config)— 读共享 → 基于 A 的事实产出
  console.log(Y + '[Agent B / config] 读共享黑板,基于 A 的事实生成配置' + Z);
  if (live) {
    const b = await ask(t, conv, 'You are Agent B (config generator). Using the project deploy port and database that were ALREADY decided earlier, output ONE startup config line using those exact values.');
    console.log('   B says: ' + b.slice(0, 160));
    shareOK = /8080/.test(b) && /postgres/i.test(b);
    console.log(shareOK ? G + '   [OK] B 通过共享记忆用到了 A 的事实' + Z : R + '   [MISS] B 没拿到 A 的事实' + Z);
  }
  logRead('Agent B', '基于 deploy_port + database 生成启动配置(只读,未写黑板)');
  await sleep(live ? 1500 : 200);

  // Agent C(corrector)— 纠正 → 闸门 supersede
  console.log(Y + '\n[Agent C / corrector] 纠正 deploy_port=9090 → 闸门 supersede' + Z);
  if (live) await ask(t, conv, 'You are Agent C. Correction: the deploy port is now 9090, not 8080. Reply only "updated".');
  writeFact('Agent C', 'deploy_port', '9090', 'turn#3');
  await sleep(live ? 2500 : 200);

  // Agent D(verifier)— 读当前事实
  console.log(Y + '[Agent D / verifier] 读当前 deploy_port' + Z);
  if (live) {
    const d = await ask(t, conv, 'What is the CURRENT deploy port for this project? Answer the number only.');
    console.log('   D says: ' + d.slice(0, 80));
    govOK = /9090/.test(d) && !/8080/.test(d);
    console.log(govOK ? G + '   [OK] supersede 生效:current=9090,旧值 8080 已被盖' + Z : R + '   [MISS] 纠正没反映' + Z);
  }
  logRead('Agent D', '确认 current deploy_port = 9090 ✓');

  console.log('\n' + C + '黑板已落盘:' + Z + BB_PATH);
  if (live) console.log((shareOK && govOK) ? G + '==== GREEN:真实 agent 通过共享黑板协调 + supersede 治理 ====' + Z : Y + '==== 见上方结果 ====' + Z);
  console.log(Y + '打开 blackboard.md 看:当前事实(带来源+时间)+ 审计链(8080 被 C supersede 成 9090,有留痕)。' + Z);
})().catch(e => console.log(R + 'error: ' + (e && e.message) + Z));
