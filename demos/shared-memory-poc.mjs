// Shared-Memory PoC — two agent ROLES coordinate through ONE shared MASE memory thread
// (blackboard primitive) + supersede governance. Minimal; concurrency/poisoning/4000-step = roadmap.
const BASE='http://127.0.0.1:3017';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const G='\x1b[32m',R='\x1b[31m',Y='\x1b[33m',C='\x1b[36m',Z='\x1b[0m';
async function ask(t,conv,prompt){
  const ac=new AbortController();const tm=setTimeout(()=>ac.abort(),60000);let text='';
  try{
    const res=await fetch(BASE+'/api/agent/chat/stream',{method:'POST',signal:ac.signal,headers:{'content-type':'application/json',authorization:'Bearer '+t},body:JSON.stringify({prompt,conversationId:conv,trustedRoot:'C:/Users/Administrator',autoApprove:true,maxSteps:3})});
    const rd=res.body.getReader();const dec=new TextDecoder();let buf='';
    while(true){const{done,value}=await rd.read();if(done)break;buf+=dec.decode(value,{stream:true});const parts=buf.split('\n\n');buf=parts.pop()||'';for(const b of parts){const evt=(b.split('\n').find(l=>l.startsWith('event:'))||'').slice(6).trim();const d=b.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trim()).join('');if(!d||d==='[DONE]')continue;let j;try{j=JSON.parse(d)}catch{continue}if(evt==='token'&&typeof j.delta==='string')text+=j.delta;if(evt==='done'&&typeof j.text==='string'&&j.text)text=j.text;}}
  }catch(e){}finally{clearTimeout(tm);}
  return text.trim();
}
(async()=>{
  console.log(C+'=== Shared-Memory PoC: agents coordinating via ONE shared MASE memory (blackboard) ==='+Z);
  let t;try{t=(await (await fetch(BASE+'/api/auth/guest',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).json()).token;}catch{}
  if(!t){console.log(R+'X  Host not up (3017). Launch Agent Cowork via desktop shortcut first.'+Z);return;}
  const conv='shared-poc-'+Date.now();
  console.log(Y+'\n[Agent A / Recorder] writing project facts into shared memory...'+Z);
  await ask(t,conv,'You are Agent A (recorder). Record these project facts: deploy port is 8080, database is PostgreSQL. Reply only "recorded".');
  await sleep(2500);
  console.log(Y+'[Agent B / Config] reading shared memory, building on Agent A...'+Z);
  const b=await ask(t,conv,'You are Agent B (config generator). Using the project deploy port and database that were ALREADY decided earlier, output ONE startup config line using those exact values.');
  console.log('   B says: '+b.slice(0,160));
  const shareOK=/8080/.test(b)&&/postgres/i.test(b);
  console.log(shareOK?G+'   [OK] B used A\x27s facts via shared memory (8080 + PostgreSQL)'+Z:R+'   [MISS] B did not pick up A\x27s facts'+Z);
  await sleep(1500);
  console.log(Y+'\n[Agent C / Corrector] correcting a shared fact (supersede)...'+Z);
  await ask(t,conv,'You are Agent C. Correction: the deploy port is now 9090, not 8080. Reply only "updated".');
  await sleep(2500);
  console.log(Y+'[Agent D / Verifier] re-reading the CURRENT shared fact...'+Z);
  const d=await ask(t,conv,'What is the CURRENT deploy port for this project? Answer the number only.');
  console.log('   D says: '+d.slice(0,80));
  const govOK=/9090/.test(d)&&!/8080/.test(d);
  console.log(govOK?G+'   [OK] supersede governance: current=9090, old 8080 overridden'+Z:R+'   [MISS] correction not reflected'+Z);
  console.log('\n'+((shareOK&&govOK)?G+'==== GREEN: agents coordinated through shared MASE memory + supersede governance ===='+Z:Y+'==== see results above ===='+Z));
  console.log('Note: minimal blackboard primitive (sequential, one shared thread). Concurrency / poisoning / 4000-step = roadmap.');
})().catch(e=>console.log(R+'error: '+(e&&e.message)+Z));
