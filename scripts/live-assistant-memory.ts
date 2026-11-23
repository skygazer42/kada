import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';
import { mkdir,readFile,writeFile } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { createServer } from 'node:net';
import { createHash,randomUUID } from 'node:crypto';
import { createModels,createProvider } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { cloudModels } from '../src/models.js';
import { serve } from '../src/server.js';
import { createClient } from '../src/client.js';
import { conversationAnswer } from '../src/conversation.js';
import { until } from '../test/helpers.js';

let apiKey = process.env.SILICONFLOW_API_KEY ?? '';
if (!apiKey) {
  assert(process.stdin.isTTY,'Set SILICONFLOW_API_KEY or use a terminal.');
  process.stdin.setRawMode(true);
  const input = createInterface({input:process.stdin,terminal:false});
  console.log('READY_FOR_CREDENTIAL');
  apiKey = await new Promise<string>(done => input.once('line',done));
  input.close();process.stdin.setRawMode(false);process.stdin.pause();
}
assert(apiKey.trim(),'A credential is required.');
const modelId = process.env.SILICONFLOW_MODEL ?? 'Qwen/Qwen2.5-7B-Instruct';
const template = cloudModels().getModel('siliconflow','Qwen/Qwen2.5-7B-Instruct')!;
const original = cloudModels().getModel('siliconflow',modelId);
if (!original) {
  const response = await fetch(template.baseUrl+'/models',{headers:{Authorization:'Bearer '+apiKey},signal:AbortSignal.timeout(15000)});
  assert.equal(response.status,200,'model_catalog_authentication');
  const catalog=await response.json() as {data:{id:string}[]};
  assert(catalog.data.some(model=>model.id===modelId),'model_available_in_account');
}
const model = {...(original ?? template),id:modelId,name:modelId,maxTokens:1536};
const native = openAICompletionsApi(),deadline = AbortSignal.timeout(12*60_000);
let requests=0;
const options = (input:any) => {
  assert(requests < 32,'Live request limit reached.');requests++;
  return {...input,maxTokens:Math.min(input?.maxTokens ?? 1536,1536),signal:AbortSignal.any([deadline,...(input?.signal ? [input.signal] : [])])};
};
const models = createModels();
models.setProvider(createProvider({id:'siliconflow',models:[model],baseUrl:model.baseUrl,
  auth:{apiKey:{name:'SiliconFlow live validation',resolve:async()=>({auth:{apiKey}})}},
  api:{stream:(selected,context,config)=>native.stream(selected,context,options(config)),streamSimple:(selected,context,config)=>native.streamSimple(selected,context,options(config))}}));
const directory = resolve('.harness/live-assistant-memory',randomUUID());
const home = join(directory,'home'),alpha=join(directory,'alpha'),beta=join(directory,'beta');
await Promise.all([home,join(directory,'.git'),join(alpha,'.git'),join(beta,'.git')].map(path=>mkdir(path,{recursive:true})));
await writeFile(join(alpha,'AGENTS.md'),'日报回复语言 language 偏好：中文。\n\n日报项目内部代号是 COMET_7391。');
await writeFile(join(beta,'AGENTS.md'),'日报回复语言 language 偏好：英文。');
const socket=createServer();await new Promise<void>(done=>socket.listen(0,'127.0.0.1',done));
const port=(socket.address() as {port:number}).port;await new Promise<void>(done=>socket.close(()=>done()));
const config={dataDir:join(directory,'state'),port,model:{provider:'siliconflow',modelId},maxSubagents:2,maxDurationMs:180_000,maxTotalTokens:100_000,review:false,web:false,discovery:true};
let server=await serve(config,{models,discovery:{home,timezone:'America/New_York'}});
const client=createClient(config);
const results:Record<string,{passed:boolean;detail?:string}>={};
const tasks=new Set<string>();
const selectedCases=(process.env.KADA_LIVE_CASES ?? '').split(',').filter(Boolean);
async function check(name:string,work:()=>Promise<void>) {
  if(selectedCases.length && !selectedCases.some(prefix=>name.startsWith(prefix))) return;
  try { await work();results[name]={passed:true}; }
  catch(error) {results[name]={passed:false,detail:error instanceof assert.AssertionError ? (['chinese_project_reply','project_code_injected','english_project_reply','cross_project_code_excluded','project_fact_visible'].includes(error.message.split('\n')[0] ?? '') ? error.message.split('\n')[0] : 'independent_assertion_failed') : error instanceof Error && error.message.startsWith('Timed out waiting') ? 'state_timeout' : 'operation_failed'};}
  console.log(JSON.stringify({stage:name,...results[name],requests}));
}
async function chat(workspace:string,prompt:string) {
  const task=await server.runtime.create(prompt,workspace,[],{chat:true});tasks.add(task.id);
  const status=await until(()=>server.runtime.status(task.id),status=>['answered','failed','budget_limited','waiting_user'].includes(status.status),90_000);
  assert.equal(status.status,'answered');
  assert.equal(status.goal,undefined);
  return {status,answer:status.messages.map(conversationAnswer).filter(text=>text!==undefined).at(-1) ?? '',memory:await server.runtime.taskMemory(task.id)};
}
let initialId:string|undefined;
try {
  await check('F01-F04-memory-scope-correction-forget',async()=>{
    const first=await chat(alpha,'请按日报 language 偏好用一句话问候我；调用 user_memory_search 选择 work 域查询“内部代号”，然后包括查到的代号。不要修改记忆。');
    initialId=first.status.id;
    assert.match(first.answer,/[\u4e00-\u9fff]/,'chinese_project_reply');assert.match(first.answer,/COMET_7391/,'project_code_injected');
    const second=await chat(beta,'请按日报 language 偏好用一句话问候我。不要修改记忆。');
    assert.match(second.answer,/[A-Za-z]/,'english_project_reply');assert(!second.answer.includes('COMET_7391'),'cross_project_code_excluded');
    assert(!/[\u4e00-\u9fff]/.test(second.answer),'english_project_reply');
    const view=await server.runtime.localMemory(alpha);
    const fact=view.facts.find(fact=>fact.text.includes('language'))!;assert(fact,'project_fact_visible');
    const changed=await server.runtime.changeMemory(fact.id,{action:'correct',text:'日报回复语言 language 偏好：英文。',expectedRevision:fact.revision,requestId:'live-correct'},alpha);
    const code=(await server.runtime.localMemory(alpha)).facts.find(fact=>fact.text.includes('COMET_7391'))!;assert(code);
    await server.runtime.changeMemory(code.id,{action:'forget',expectedRevision:code.revision,requestId:'live-forget'},alpha);
    const next=await chat(alpha,'请按日报 language 偏好用一句话问候我。只用已注入记忆，不读取文件。代号仅在可用时包括；没有则说 no code。不要修改记忆。');
    assert.match(next.answer,/[A-Za-z]/);assert(!next.answer.includes('COMET_7391'));
    assert(!/[\u4e00-\u9fff]/.test(next.answer),'english_project_reply');
    assert(next.memory.references.some(reference=>reference.factId===changed.id && next.memory.current.includes(reference.factId+'@'+reference.revision)));
    assert(!(next.memory.references.some(reference=>reference.factId===code.id)));
    const previous=await server.runtime.taskMemory(first.status.id);
    assert(previous.references.some(reference=>reference.factId===fact.id && reference.revision===fact.revision));
  });
  await check('F05-F06-handoff-and-read-notification',async()=>{
    const task=await server.runtime.create('You must call task_blocked with reason "Synthetic missing input" and question "Which filename?". Do not guess a filename.',alpha);tasks.add(task.id);
    await until(()=>server.runtime.status(task.id),status=>status.status==='waiting_user',90_000);
    assert((await server.runtime.list('pending')).some(item=>item.id===task.id && item.summary.includes('Which filename')));
    const notification=(await server.runtime.notifications()).find(item=>item.taskId===task.id)!;assert(notification);
    await server.runtime.readNotification(notification.id);
    await server.close();server=await serve(config,{models,discovery:{home,timezone:'America/New_York'}});
    assert((await server.runtime.notifications()).find(item=>item.id===notification.id)!.readAt!==null);
    if(initialId) assert.equal((await server.runtime.status(initialId)).id,initialId);
  });
  await check('F11-F12-reminder-and-change-aware-routine',async()=>{
    const parsed=await models.complete(model,{messages:[{role:'user',timestamp:Date.now(),content:'Return ONLY strict JSON: {"kind":"once","at":"2026-12-01T17:00:00-05:00"}. This is a synthetic reminder at 5pm New York on December 1, 2026. No markdown.'}]},{maxTokens:100});
    const text=parsed.content.filter(part=>part.type==='text').map(part=>part.text).join('');
    const schedule=JSON.parse(text);assert.equal(Date.parse(schedule.at),Date.parse('2026-12-01T22:00:00Z'));
    const rule=await server.runtime.routines.create({action:'notify',objective:'Synthetic reminder',schedule:{kind:'once',at:new Date(Date.now()+300).toISOString()}});
    await until(()=>server.runtime.notifications(),events=>events.some(event=>event.routineId===rule.id));
    await writeFile(join(alpha,'routine-summary.json'),'["synthetic change"]');
    for(const day of ['01','02']) {
      const task=await server.runtime.create('Read routine-summary.json. Call task_submit with summary "Directory summary" and artifacts ["routine-summary.json"]. Do not modify files.',alpha,[],{routineOccurrenceId:'live-summary/1/2026-12-'+day+'T22:00:00.000Z',notifyOnChange:true});tasks.add(task.id);
      await until(()=>server.runtime.status(task.id),status=>status.status==='completed',90_000);
    }
    assert.equal((await server.runtime.notifications()).filter(event=>event.routineId==='live-summary' && event.event==='completed').length,1);
  });
  await check('F13-F15-mobile-reconnect-attachment-delivery',async()=>{
    const paired=await client.request<{token:string}>('/v1/remote/devices','POST',{accountId:'live-owner',deviceId:'live-phone'});
    const headers={Authorization:'Bearer '+paired.token};
    const base=`http://127.0.0.1:${port}/remote/api/conversations/live-file`;
    const input='Synthetic report: alpha=19, beta=23.';
    const upload=await fetch(base+'/uploads',{method:'POST',headers:{...headers,'Content-Type':'text/plain','X-Kada-Filename':'input.txt','X-Kada-SHA256':createHash('sha256').update(input).digest('hex')},body:input});
    assert.equal(upload.status,201);
    const attachment=await upload.json();
    const body={messageId:'single-message',text:'Create summary.txt containing "Total 42" from the attached synthetic text. Call task_prepare now, without reading files yet: outcome "Create summary.txt", deliverables ["summary.txt"], inputs [the displayed attachment path], criteria [{text:"summary.txt contains Total 42",method:"inspect"}], scope ["workspace"], assumptions [], questions [], budget {maxEstimatedCostUsd:1,maxDurationMs:180000,maxTotalTokens:100000}. Keep every field concise. Wait for my confirmation, then read the attachment, write summary.txt and call the actual task_submit with criterion 1 evidence. Do not use external services.',attachmentIds:[attachment.id]};
    const post=()=>fetch(base+'/messages',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(body)});
    const receipt=await (await post()).json();assert(receipt.taskId);tasks.add(receipt.taskId);
    const get=async()=>{const response=await fetch(base,{headers});assert.equal(response.status,200);return response.json();};
    const brief=await until(get,state=>['awaiting_confirmation','failed','budget_limited','waiting_user'].includes(state.task?.status),180_000);
    assert.equal(brief.task.status,'awaiting_confirmation','remote_brief_ready');
    const duplicate=await (await post()).json();assert.equal(duplicate.taskId,receipt.taskId);assert.equal(duplicate.requestId,receipt.requestId);
    const confirmation=await fetch(base+'/confirm',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({revision:brief.task.brief.revision,digest:brief.task.briefDigest})});assert.equal(confirmation.status,200);
    const done=await until(get,state=>['completed','failed','budget_limited','waiting_user','needs_attention'].includes(state.task?.status),180_000);
    assert.equal(done.task.status,'completed','remote_delivery_verified');
    const file=done.task.delivery.artifacts.find((file:{kind:string})=>file.kind==='file');assert(file);
    const download=await fetch(`http://127.0.0.1:${port}`+file.href,{headers});assert.equal(download.status,200);
    const bytes=Buffer.from(await download.arrayBuffer());
    assert.match(bytes.toString('utf8'),/Total\s*42/);
    assert.equal(createHash('sha256').update(bytes).digest('hex'),download.headers.get('x-kada-sha256'));
    assert((await server.runtime.artifacts(receipt.taskId)).every(file=>file.state==='verified'));
  });
  await check('F17-two-owned-workers-return-verified-files',async()=>{
    const workspace=join(directory,'team');await mkdir(join(workspace,'.git'),{recursive:true});
    const task=await server.runtime.create('Use delegate exactly once for two independent workers named alpha and beta. Tell alpha: use native write with relative path result.json and content 19 in your own current directory, and return its absolute path. Tell beta: same relative path result.json with content 23 in your own current directory. Do not put parent workspace paths in worker instructions. After both finish, use native read on the exact returned absolute paths, write total.json containing JSON number 42 in the main workspace, then call the actual task_submit tool with summary "Total 42" and artifacts ["total.json"]. Never paste tool calls as text.',workspace,[{type:'json_value',path:'total.json',pointer:'',equals:42}]);tasks.add(task.id);
    const done=await until(()=>server.runtime.status(task.id),status=>['completed','failed','budget_limited','waiting_user'].includes(status.status),120_000);
    assert.equal(done.status,'completed');assert.equal(done.delegations.length,2);
    assert.deepEqual((await Promise.all(done.delegations.map(async child=>JSON.parse(await readFile(join(child.directory,'result.json'),'utf8'))))).sort((a,b)=>a-b),[19,23]);
    assert(done.delegations.every(child=>child.status==='completed' && child.usage.totalTokens>0));
    assert.equal(JSON.parse(await readFile(join(workspace,'total.json'),'utf8')),42);
  });
} finally {
  const usage=[];
  for(const id of tasks) {try {const state=await server.runtime.status(id);usage.push({id,tokens:state.budget.totalTokens,input:state.budget.inputTokens,output:state.budget.outputTokens,cached:state.budget.cachedTokens});} catch { /* A failed admission has no task ledger. */ }}
  await server.close();
  const report={at:new Date().toISOString(),model:modelId,customCatalog:!original,selection:selectedCases,fullSuite:selectedCases.length===0,passed:Object.values(results).every(result=>result.passed),maxRequests:32,modelRequests:requests,maxOutputTokensPerRequest:1536,estimatedCostUsd:null,results,tasks:usage,totalTaskTokens:usage.reduce((sum,item)=>sum+item.tokens,0),note:'Task ledger includes owned workers; the standalone reminder parsing call is additionally bounded by the request counter. Deterministic kill/clock/permission tests are separate.'};
  await mkdir(resolve('docs/experiments'),{recursive:true});await writeFile(resolve('docs/experiments/2026-11-23-assistant-memory'+(selectedCases.length ? '-focused' : '')+'.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({passed:report.passed,requests,totalTaskTokens:report.totalTaskTokens}));
  if(!report.passed) process.exitCode=1;
}
