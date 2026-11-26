import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';
import { mkdir,readFile,writeFile } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { createServer } from 'node:net';
import { Agent, request, createServer as createHttpServer } from 'node:http';
import type { request as HttpsRequest } from 'node:https';
import { createHash,randomUUID } from 'node:crypto';
import { createModels,createProvider,Type } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { defineExtension, hook, ToolTask } from '@earendil-works/pi-durable';
import { cloudModels } from '../src/models.js';
import { serve } from '../src/server.js';
import { createClient, type TaskStatus } from '../src/client.js';
import { ChatSession } from '../src/chat.js';
import { conversationAnswer } from '../src/conversation.js';
import type { Routine } from '../src/routines.js';
import { fakeRoutineClock, until } from '../test/helpers.js';

let apiKey = process.env.SILICONFLOW_API_KEY ?? '';
delete process.env.SILICONFLOW_API_KEY;
if (!apiKey) {
  assert(process.stdin.isTTY || process.argv.includes('--credential-stdin'),'Set SILICONFLOW_API_KEY or use a terminal.');
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  const input = createInterface({input:process.stdin,terminal:false});
  console.log('READY_FOR_CREDENTIAL');
  apiKey = await new Promise<string>(done => input.once('line',done));
  input.close();if (process.stdin.isTTY) process.stdin.setRawMode(false);process.stdin.pause();
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
const maxRequests = process.env.KADA_LIVE_CASES === 'K01-application-credential' ? 10 : ['F11-chat-reminder-management','W01-chat-work-items','W02-work-item-planning'].includes(process.env.KADA_LIVE_CASES ?? '') ? 12 : ['F11-chat-reminder','H01-project-history','D01-mcp-discovery','T01-project-tasks','Q01-structured-question'].includes(process.env.KADA_LIVE_CASES ?? '') ? 8 : 32;
let requests=0;
let onModelRequest: (() => void) | undefined;
const options = (input:any) => {
  assert(requests < maxRequests,'Live request limit reached.');requests++;
  return {...input,maxTokens:Math.min(input?.maxTokens ?? 1536,1536),signal:AbortSignal.any([deadline,...(input?.signal ? [input.signal] : [])])};
};
function observe<T>(stream: T): T {
  onModelRequest?.();
  return stream;
}
const models = createModels();
let protectedMarker: string | undefined;
function protectedContext(context: unknown) { assert(!protectedMarker || !JSON.stringify(context).includes(protectedMarker),'protected_value_absent_from_model_context'); }
models.setProvider(createProvider({id:'siliconflow',models:[model],baseUrl:model.baseUrl,
  auth:{apiKey:{name:'SiliconFlow live validation',resolve:async()=>({auth:{apiKey}})}},
  api:{stream:(selected,context,config)=>{protectedContext(context);return observe(native.stream(selected,context,options(config)));},streamSimple:(selected,context,config)=>{protectedContext(context);return observe(native.streamSimple(selected,context,options(config)));}}}));
const directory = resolve('.harness/live-assistant-memory',randomUUID());
const home = join(directory,'home'),alpha=join(directory,'alpha'),beta=join(directory,'beta');
await Promise.all([home,join(directory,'.git'),join(alpha,'.git'),join(beta,'.git')].map(path=>mkdir(path,{recursive:true})));
await writeFile(join(alpha,'AGENTS.md'),'日报回复语言 language 偏好：中文。\n\n日报项目内部代号是 COMET_7391。');
await writeFile(join(beta,'AGENTS.md'),'日报回复语言 language 偏好：英文。');
const socket=createServer();await new Promise<void>(done=>socket.listen(0,'127.0.0.1',done));
const port=(socket.address() as {port:number}).port;await new Promise<void>(done=>socket.close(()=>done()));
const config={dataDir:join(directory,'state'),port,model:{provider:'siliconflow',modelId},maxSubagents:2,maxDurationMs:180_000,maxTotalTokens:100_000,review:false,web:false,discovery:true};
const routineClock = fakeRoutineClock(Date.parse('2026-12-01T21:00:00Z'));
const routineScope = defineExtension({name:'live-inventory-scope',hooks:[hook(ToolTask,{
  beforeTool(call) {
    const allowed = ['reminders_info','reminder_create','reminder_update','reminder_cancel'].includes(call.name) ||
      (call.name === 'read' && call.arguments.path === 'reports/inventory.txt') ||
      (call.name === 'write' && call.arguments.path === 'routine-summary.json') || call.name === 'task_submit';
    if (!allowed) return {block:'Use read on reports/inventory.txt, write routine-summary.json, then task_submit.'};
  },
})]});
const routineOnly = process.env.KADA_LIVE_CASES === 'F11';
const selectedCases=(process.env.KADA_LIVE_CASES ?? '').split(',').filter(Boolean);
let credentialCalls=0;
const credentialService=(!selectedCases.length || selectedCases.some(prefix=>'K01-application-credential'.startsWith(prefix))) ? createHttpServer((req,res)=>{
  if(req.headers.authorization!=='Bearer '+protectedMarker){res.writeHead(401).end();return;}
  credentialCalls++;res.end(JSON.stringify({report:'CREDENTIAL_REPORT_628'}));
}) : undefined;
if(credentialService) {protectedMarker='synthetic-live-private-'+randomUUID();await new Promise<void>(done=>credentialService.listen(0,'127.0.0.1',done));}
const credentialNetwork=credentialService ? {lookup:async()=>[{address:'8.8.8.8',family:4}],request:((settings:any,callback:any)=>{
  assert.equal(settings.hostname,'api.example','credential_host_bound');
  return request({...settings,protocol:'http:',hostname:'127.0.0.1',port:(credentialService.address() as {port:number}).port,lookup:undefined},callback);
}) as typeof HttpsRequest} : undefined;
const serverOptions = {models, discovery:{home,timezone:'America/New_York'}, routineClock,
  ...(credentialNetwork ? {credentialNetwork} : {}),
  ...(routineOnly ? {extensions:[routineScope]} : {})};
let server=await serve(config,serverOptions);
const client=createClient(config);
const results:Record<string,{passed:boolean;detail?:string}>={};
const evidence: Record<string, unknown> = {};
const tasks=new Set<string>();
async function check(name:string,work:()=>Promise<void>) {
  if(selectedCases.length && !selectedCases.some(prefix=>name.startsWith(prefix))) return;
  try { await work();results[name]={passed:true}; }
  catch(error) {results[name]={passed:false,detail:error instanceof assert.AssertionError ? (['chinese_project_reply','project_code_injected','english_project_reply','cross_project_code_excluded','project_fact_visible'].includes(error.message.split('\n')[0] ?? '') ? error.message.split('\n')[0] : 'independent_assertion_failed') : error instanceof Error && error.message.startsWith('Timed out waiting') ? 'state_timeout' : 'operation_failed'};}
  console.log(JSON.stringify({stage:name,...results[name],requests}));
}
async function chat(workspace:string,prompt:string,timeoutMs=90_000) {
  const task=await server.runtime.create(prompt,workspace,[],{chat:true});tasks.add(task.id);
  const status=await until(()=>server.runtime.status(task.id),status=>['answered','failed','budget_limited','waiting_user'].includes(status.status),timeoutMs);
  assert.equal(status.status,'answered');
  assert.equal(status.goal,undefined);
  return {status,answer:status.messages.map(conversationAnswer).filter(text=>text!==undefined).at(-1) ?? '',memory:await server.runtime.taskMemory(task.id)};
}
try {
  await check('F01-F04-memory-scope-correction-forget',async()=>{
    const first=await chat(alpha,'请按日报 language 偏好用一句话问候我；调用 user_memory_search 选择 work 域查询“内部代号”，然后包括查到的代号。不要修改记忆。');
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
  await check('F05-F07-concurrent-handoff-notifications-and-artifacts',async()=>{
    const create = async (workspace:string, objective:string, acceptance:unknown[] = []) => {
      const task = await client.request<{id:string}>('/v1/tasks','POST',{confirmed:true,workspace,objective,acceptance});
      tasks.add(task.id);
      return task;
    };
    const artifacts = { 'result.json': '{"total":42,"currency":"USD"}', 'summary.md': '# Summary\nTotal: USD 42' };
    const [waiting, delivery] = await Promise.all([
      create(alpha,'Call task_blocked with reason "Synthetic missing input" and question "Which filename?". Do not guess a filename.'),
      create(beta,`Use the write tool twice to create these two files with the exact content in this JSON map: ${JSON.stringify(artifacts)}. Then call task_submit with summary "Total verified", artifacts ["result.json", "summary.md"], and no additional criteria. Do not modify other files.`,[
        {type:'json_value',path:'result.json',pointer:'/total',equals:42},
        {type:'json_value',path:'result.json',pointer:'/currency',equals:'USD'},
        {type:'file_contains',path:'summary.md',text:'Total: USD 42'},
      ]),
    ]);
    const [pending, delivered] = await Promise.all([
      until(()=>server.runtime.status(waiting.id),status=>status.status==='waiting_user',90_000),
      until(()=>server.runtime.status(delivery.id),status=>status.status==='completed',90_000),
    ]);
    assert.equal(pending.goal?.question,'Which filename?');
    const notifications = await server.runtime.notifications();
    const waitingEvents = notifications.filter(item=>item.taskId===waiting.id);
    const deliveryEvents = notifications.filter(item=>item.taskId===delivery.id);
    assert.equal(waitingEvents.filter(item=>item.event==='waiting_user').length,1);
    assert.equal(deliveryEvents.filter(item=>item.event==='completed').length,1);
    const files = await client.request<{path:string;sha256:string;bytes:number;state:string}[]>(`/v1/tasks/${delivery.id}/artifacts`);
    assert.equal(files.length,2);
    for (const [name,expected] of Object.entries(artifacts)) {
      const path = join(delivered.workspace,name);
      const bytes = await readFile(path);
      assert.deepEqual(bytes,Buffer.from(expected),`exact artifact bytes: ${name}`);
      assert(files.some(file=>file.path===path && file.state==='verified' && file.bytes===bytes.length && file.sha256===createHash('sha256').update(bytes).digest('hex')));
    }
    await server.close();server=await serve(config,serverOptions);
    const terminalOutput: string[] = [];
    const terminal = new ChatSession(createClient(config),event=>terminalOutput.push(event.text));
    await terminal.handle('/tasks pending');
    assert(terminalOutput.some(line=>line.includes(waiting.id) && line.includes('Which filename?')));
    assert(!terminalOutput.some(line=>line.includes(delivery.id)));
    await terminal.handle(`/attach ${waiting.id}`);
    assert.equal(terminal.taskId,waiting.id);
    assert(terminalOutput.some(line=>line.includes('Which filename?')));
    await terminal.handle(`/attach ${delivery.id}`);
    await terminal.handle('/files');
    assert.equal(terminal.taskId,delivery.id);
    assert(files.every(file=>terminalOutput.some(line=>line.includes(file.path))));
    const reopened = await server.runtime.notifications();
    assert([...waitingEvents,...deliveryEvents].every(event=>reopened.some(row=>row.id===event.id && row.readAt!==null)));
    evidence.handoff = {pendingTaskId:waiting.id,deliveredTaskId:delivery.id,reopenedOriginalTasks:true,readNotificationsRetained:true,
      artifacts:Object.entries(artifacts).map(([name,content])=>({name,bytes:Buffer.byteLength(content),sha256:createHash('sha256').update(content).digest('hex')}))};
  });
  await check('F14-in-flight-client-disconnect',async()=>{
    const paired = await client.request<{token:string}>('/v1/remote/devices','POST',{accountId:'live-reconnect',deviceId:'live-phone'});
    const headers = {Authorization:'Bearer '+paired.token,'Content-Type':'application/json'};
    const base = `http://127.0.0.1:${port}/remote/api/conversations/live-disconnect`;
    const messageId = 'during-model';
    const expected = 'RECONNECT_421';
    const payload = JSON.stringify({messageId,text:`This is a plain greeting test. Reply with only ${expected}. No tools or tasks.`});
    const agent = new Agent({keepAlive:true});
    const before = requests;
    let destroyed = false;
    try {
      await new Promise<void>((done,reject)=>{
        const outgoing = request(base+'/messages',{method:'POST',agent,headers:{...headers,'Content-Length':Buffer.byteLength(payload)},signal:AbortSignal.timeout(25_000)},response=>response.resume());
        outgoing.on('error',error=>{if (!destroyed) reject(error);});
        onModelRequest = () => {
          const active = outgoing.socket;
          if (!active || active.destroyed) { reject(new Error('No live remote client connection')); return; }
          destroyed = true;
          agent.destroy();
          done();
        };
        outgoing.end(payload);
      });
    } finally {
      onModelRequest = undefined;
      agent.destroy();
    }
    assert(destroyed);
    const retry = await fetch(base+'/messages',{method:'POST',headers,body:payload,signal:deadline});
    assert.equal(retry.status,200,'submission is already owned by the original request');
    const originalReceipt = await retry.json();
    tasks.add(originalReceipt.taskId);
    const recovered = await (await fetch(base+'?messageId='+messageId,{headers,signal:deadline})).json();
    assert.equal(recovered.requestId,originalReceipt.requestId);
    assert.equal(recovered.taskId,originalReceipt.taskId);
    const status = await until(()=>client.request<TaskStatus>(`/v1/tasks/${recovered.taskId}`),item=>item.status==='answered',90_000);
    const history = await (await fetch(base,{headers,signal:deadline})).json();
    assert.equal(history.taskId,recovered.taskId);
    assert.equal(history.receipts.length,1);
    assert.equal(history.messages.filter((message:{role:string;text:string})=>message.role==='assistant' && message.text.trim()===expected).length,1);
    assert.equal(new Set(history.messages.map((message:{sequence:number})=>message.sequence)).size,history.messages.length);
    assert.equal(requests-before,1,'reconnect must not generate a second response');
    evidence.disconnect = {taskId:status.id,requestId:recovered.requestId,clientClosedDuringRequest:true,modelRequests:requests-before,assistantReplies:1};
  });
  await check('D01-mcp-discovery',async()=>{
    const effects=join(directory,'mcp-discovery-calls.txt');
    const catalog=Array.from({length:21},(_,index)=>({name:'record_'+index,description:'Read synthetic record '+index,
      inputSchema:{type:'object',properties:{},additionalProperties:false}}));
    const fixture=`const fs=require('node:fs');const input=require('node:readline').createInterface({input:process.stdin});
input.on('line',line=>{const r=JSON.parse(line);if(r.id===undefined)return;let result;
if(r.method==='initialize')result={protocolVersion:r.params.protocolVersion,serverInfo:{name:'discovery-live',version:'1'},capabilities:{tools:{}}};
if(r.method==='tools/list')result={tools:${JSON.stringify(catalog)}};
if(r.method==='tools/call'){fs.appendFileSync(process.argv[1],r.params.name+'\\n');result={content:[{type:'text',text:r.params.name==='record_20'?'DISCOVERY_729':'Wrong record'}]};}
console.log(JSON.stringify({jsonrpc:'2.0',id:r.id,result}));});`;
    await server.runtime.mcp.configure({id:'records',transport:'stdio',command:process.execPath,args:['-e',fixture,effects]});
    const tested=await server.runtime.mcp.test('records');
    await server.runtime.mcp.enable('records',catalog.map(tool=>tool.name),tested.revision);
    const task=await server.runtime.create('使用已连接 MCP 的 record_20 工具读取合成记录。先用 tool_search 搜索 record_20，然后调用找到的 MCP 工具，不要读取文件或使用 bash。最后用 task_submit 提交工具返回的代号，artifacts 为空。',alpha);tasks.add(task.id);
    const done=await until(()=>server.runtime.status(task.id),status=>['completed','failed','budget_limited','waiting_user','needs_attention'].includes(status.status),120_000);
    assert.equal(done.status,'completed','discovery_task_completed');
    assert.equal(done.mcpDiscovery,'deferred');
    const initial=done.messages.find(message=>message.role==='system' && message.toolsAdded?.some(tool=>tool.name==='tool_search'));
    assert(initial?.role==='system');
    assert(!initial.toolsAdded?.some(tool=>tool.name.startsWith('mcp_records_')),'discovery_initial_schema_hidden');
    assert(done.messages.some(message=>message.role==='toolResult' && message.toolName==='tool_search' && !message.isError),'discovery_search_succeeded');
    assert.match(done.goal?.candidate?.summary ?? '',/DISCOVERY_729/,'discovery_returned_marker');
    assert.equal(await readFile(effects,'utf8'),'record_20\n','discovery_one_selected_call');
    const beforeRestart=requests;
    await server.close();server=await serve(config,serverOptions);
    assert.equal(requests,beforeRestart,'discovery_reopen_no_model');
    const loaded=await server.runtime['active'].get(task.id)!.root.agent((await import('@earendil-works/chord/context')).BACKGROUND_CONTEXT);
    assert(loaded.tools.some(tool=>tool.name.startsWith('mcp_records_record_20_')),'discovery_loaded_after_reopen');
    evidence.mcpDiscovery={taskId:task.id,catalogSize:catalog.length,initialMcpSchemas:0,selectedCalls:1,loadedAfterRestart:true,requests};
  });
  await check('K01-application-credential',async()=>{
    const source=await server.runtime.create('请为当前项目配置名为 reports 的 API 凭据，站点是 https://api.example，认证方式为 Bearer。请通过受保护的凭据输入请求，不在聊天中询问密钥；现在只配置，不执行请求。',alpha,[],{chat:true});tasks.add(source.id);
    const waiting=await until(()=>server.runtime.status(source.id),row=>['waiting_user','failed','answered','budget_limited'].includes(row.status),90_000);
    assert.equal(waiting.status,'waiting_user');assert.equal(waiting.goal,undefined);
    assert.equal(waiting.userQuestion?.credential?.name,'reports');assert.equal(waiting.userQuestion?.credential?.origin,'https://api.example');
    assert.equal(waiting.userQuestion?.credential?.auth.type,'bearer');
    const questionId=waiting.userQuestion!.id;
    await server.runtime.provideCredential(source.id,questionId,protectedMarker!);
    const saved=await until(()=>server.runtime.status(source.id),row=>['answered','failed','budget_limited'].includes(row.status),90_000);
    assert.equal(saved.status,'answered');assert.equal(saved.goal,undefined);assert(!JSON.stringify(saved).includes(protectedMarker!));
    const beforeRestart=requests;await server.close();server=await serve(config,serverOptions);
    assert.equal(requests,beforeRestart,'credential_restart_no_model');
    const task=await server.runtime.create('已授权本次读取：使用当前项目已保存的 reports 凭据读取 https://api.example/report，GET 方法。先查询 credentials_list 得到当前修订，再用 credential_request 请求一次；不要使用 bash、read 或其他网络工具。最后 task_submit 提交服务返回的 report 代号，artifacts 为空。',alpha);tasks.add(task.id);
    const done=await until(()=>server.runtime.status(task.id),row=>['completed','failed','waiting_user','budget_limited','needs_attention'].includes(row.status),90_000);
    assert.equal(done.status,'completed');assert.match(done.goal?.candidate?.summary ?? '',/CREDENTIAL_REPORT_628/);
    assert.equal(credentialCalls,1,'one_authenticated_request');assert(!JSON.stringify(done).includes(protectedMarker!));
    const disk=await readFile(join(config.dataDir,'tasks',source.id,'session.sqlite'));
    assert(!disk.includes(Buffer.from(protectedMarker!)),'credential_absent_from_pi_storage');
    evidence.applicationCredential={sourceTaskId:source.id,executionTaskId:task.id,protectedInput:true,valueAbsentFromModelAndPi:true,authenticatedRequests:credentialCalls,restartNoModel:true,chatGoalCreated:false,requests};
  });
  await check('Q01-structured-question',async()=>{
    const source=await server.runtime.create('只问我一个普通选择题：周末想读书还是散步？请用 ask_user 提供“读书”和“散步”两个选项，然后等待。不创建任务说明，不执行工作。',alpha,[],{chat:true});tasks.add(source.id);
    const waiting=await until(()=>server.runtime.status(source.id),row=>['waiting_user','failed','answered','budget_limited'].includes(row.status),90_000);
    assert.equal(waiting.status,'waiting_user','question_waiting');assert.equal(waiting.goal,undefined);
    const question=waiting.userQuestion!;assert.deepEqual(question.options,['读书','散步'],'question_choices');
    const beforeRestart=requests;
    await server.close();server=await serve(config,serverOptions);
    assert.equal(requests,beforeRestart,'question_reopen_no_model');
    assert.deepEqual((await server.runtime.status(source.id)).userQuestion,question,'question_original_identity');
    await server.runtime.answerQuestion(source.id,question.id,'live-question-choice','读书');
    const done=await until(()=>server.runtime.status(source.id),row=>['answered','failed','budget_limited'].includes(row.status),90_000);
    assert.equal(done.status,'answered');assert.equal(done.goal,undefined);assert.equal(done.userQuestion,null);
    assert.match(done.messages.map(conversationAnswer).filter(Boolean).at(-1) ?? '',/读书|书/);
    const afterAnswer=requests;
    await server.runtime.answerQuestion(source.id,question.id,'live-question-choice','读书');
    assert.equal(requests,afterAnswer,'question_one_answer');
    assert.equal(done.messages.filter(message=>message.role==='user' && message.content==='读书').length,1);
    evidence.structuredQuestion={taskId:source.id,questionId:question.id,choicesVerified:true,identityAfterRestart:true,answerOnce:true,goalCreated:false,requests};
  });
  await check('W01-chat-work-items',async()=>{
    const {status:created}=await chat(alpha,'请给这个项目保存一条待办：标题“LYRA_613 周报”，说明“整理本周的合成项目进展”。只存待办，先不要执行，不要设提醒。');
    const [item]=await server.runtime.workItems.list(alpha);
    assert(item,'todo_saved');assert.match(item.title,/LYRA_613/);assert.equal(item.status,'open');assert.equal(item.archived,false);
    assert(created.messages.some(message=>message.role==='toolResult' && message.toolName==='work_item_create' && !message.isError),'todo_create_tool');
    const beforeRestart=requests;
    await server.close();server=await serve(config,serverOptions);
    assert.equal(requests,beforeRestart,'todo_restart_no_model');
    await server.runtime.followUp(created.id,'把刚才的 LYRA_613 待办标题改为“LYRA_613 月报”，并标记为已完成；这是我手动完成的待办，不需要执行任何工作。','todo-edit');
    const done=await until(()=>server.runtime.status(created.id),row=>['answered','failed','budget_limited'].includes(row.status) && row.submission?.requestId==='user:todo-edit',90_000);
    assert.equal(done.status,'answered');assert.equal(done.goal,undefined);
    const edited=await server.runtime.workItems.get(item.id);
    assert.match(edited.title,/月报/);assert.equal(edited.status,'done');assert.equal(typeof edited.completedAt,'number');
    assert(done.messages.some(message=>message.role==='toolResult' && message.toolName==='work_item_update' && !message.isError),'todo_update_tool');
    await server.runtime.followUp(created.id,'把这条已完成的 LYRA_613 月报待办归档，保留记录，不删除。','todo-archive');
    const archived=await until(()=>server.runtime.status(created.id),row=>['answered','failed','budget_limited'].includes(row.status) && row.submission?.requestId==='user:todo-archive',90_000);
    assert.equal(archived.status,'answered');assert.equal(archived.goal,undefined);
    const final=await server.runtime.workItems.get(item.id);
    assert.equal(final.archived,true);assert.equal(final.status,'done');assert.equal(final.completedAt,edited.completedAt);
    assert.equal((await server.runtime.workItems.list(alpha)).length,1,'todo_single_identity');
    assert.deepEqual(await server.runtime.workItems.runs(item.id),[],'todo_no_execution');
    assert.doesNotMatch(JSON.stringify(final),/operations|fingerprint|requestId/);
    evidence.chatWorkItems={itemId:item.id,chatId:created.id,created:true,renamed:true,completed:true,archived:true,originalIdKept:true,goalCreated:false,runs:0,requests};
  });
  await check('W02-work-item-planning',async()=>{
    const {status:created}=await chat(alpha,'请只保存一条项目待办：标题“VEGA_812 规划”，说明“整理合成计划”，优先级 high，日期截止 2026-12-12，时区 America/New_York。这里只存规划，不执行、不创建提醒。',config.maxDurationMs+5000);
    const initial=(await server.runtime.workItems.list(alpha)).filter(item=>item.title.includes('VEGA_812'));
    assert.equal(initial.length,1,'planning_single_item');const item=initial[0]!;
    assert.equal(item.priority,'high');assert.equal(item.dueDate,'2026-12-12');assert.equal(item.dueAt,null);assert.equal(item.timeZone,'America/New_York');
    const beforeRestart=requests;await server.close();server=await serve(config,serverOptions);
    assert.equal(requests,beforeRestart,'planning_restart_no_model');
    await server.runtime.followUp(created.id,'把 VEGA_812 这条待办改为 urgent，截止改为纽约时间 2026-12-13 17:00（UTC-05:00），明确清空原日期截止 dueDate，保留同一条记录。只改规划，不执行也不设提醒。','planning-time');
    const timed=await until(()=>server.runtime.status(created.id),row=>['answered','failed','budget_limited','waiting_user','needs_attention','blocked'].includes(row.status) && row.submission?.requestId==='user:planning-time',config.maxDurationMs+5000);
    assert.equal(timed.status,'answered');assert.equal(timed.goal,undefined);
    const changed=await server.runtime.workItems.get(item.id);
    assert.equal(changed.priority,'urgent');assert.equal(changed.dueDate,null);assert.equal(changed.dueAt,'2026-12-13T22:00:00.000Z');
    await server.runtime.followUp(created.id,'清除这条 VEGA_812 待办的截止时间，把优先级改回 normal；保留原待办，不执行、不提醒。','planning-clear');
    const done=await until(()=>server.runtime.status(created.id),row=>['answered','failed','budget_limited','waiting_user','needs_attention','blocked'].includes(row.status) && row.submission?.requestId==='user:planning-clear',config.maxDurationMs+5000);
    assert.equal(done.status,'answered');assert.equal(done.goal,undefined);
    const final=await server.runtime.workItems.get(item.id);
    assert.equal(final.priority,'normal');assert.equal(final.dueDate,null);assert.equal(final.dueAt,null);assert.equal(final.timeZone,'America/New_York');
    assert.equal((await server.runtime.workItems.list(alpha)).filter(row=>row.title.includes('VEGA_812')).length,1);
    assert.deepEqual(await server.runtime.workItems.runs(item.id),[]);
    const calls=done.messages.filter(message=>message.role==='toolResult');
    assert.equal(calls.filter(message=>message.toolName==='work_item_create' && !message.isError).length,1);
    assert.equal(calls.filter(message=>message.toolName==='work_item_update' && !message.isError).length,2);
    assert(!calls.some(message=>/reminder_(?:create|update)|task_prepare/.test(message.toolName)),'planning_no_execution_or_reminder');
    evidence.workItemPlanning={itemId:item.id,chatId:created.id,dateOnlySaved:true,timedDeadlineSaved:true,deadlineCleared:true,originalIdKept:true,restartNoModel:true,goalCreated:false,runs:0,requests};
  });
  await check('T01-project-tasks',async()=>{
    const source=await server.runtime.create('合成验收任务 ORBIT_542：用户尚未决定导出 CSV 还是 XLSX，不能自行选择。只调用 task_blocked，reason 说明缺少格式，question 提问 CSV 还是 XLSX，然后等待。不要执行命令、写文件或委派。',alpha);tasks.add(source.id);
    const pending=await until(()=>server.runtime.status(source.id),row=>['waiting_user','failed','budget_limited','completed'].includes(row.status),90_000);
    assert.equal(pending.status,'waiting_user','catalog_source_waiting');
    assert.match(pending.goal?.question ?? '',/CSV/);assert.match(pending.goal?.question ?? '',/XLSX/);
    const {status:foreign}=await chat(beta,'这是另一个项目的私人讨论 FOREIGN_CATALOG_648。只回复收到，不调用工具。');
    const beforeRestart=requests;
    await server.close();server=await serve(config,serverOptions);
    assert.equal(requests,beforeRestart,'catalog_reopen_no_model');
    const {status:answer,answer:text}=await chat(alpha,'这个项目还有哪些任务在等我答复？请给出原任务 ID 和具体问题，以系统当前状态为准；不要开始、恢复或修改任何工作。');
    const result=answer.messages.find(message=>message.role==='toolResult' && message.toolName==='project_tasks' && !message.isError);
    assert(result && result.role==='toolResult','catalog_tool_succeeded');
    const page=JSON.parse(result.content.filter(block=>block.type==='text').map(block=>block.text).join(''));
    assert(page.tasks.some((task:{id:string;question:string|null})=>task.id===source.id && task.question===pending.goal?.question),'catalog_original_task_and_question');
    assert(!page.tasks.some((task:{id:string})=>task.id===foreign.id),'catalog_excludes_other_project');
    assert(text.includes(source.id),'catalog_answer_original_id');assert.match(text,/CSV/);assert.match(text,/XLSX/);
    assert(!text.includes('FOREIGN_CATALOG_648'),'catalog_answer_scope');
    assert.equal((await server.runtime.status(source.id)).status,'waiting_user');
    assert.equal(answer.goal,undefined);
    evidence.projectTasks={sourceTaskId:source.id,queryTaskId:answer.id,sourceStillWaiting:true,questionVerified:true,otherProjectExcluded:true,goalCreated:false,requests};
  });
  await check('H01-project-history',async()=>{
    const {status:source} = await chat(alpha,'项目回顾：NEBULA_842 的数据库选择是 SQLite。只回复“已记下这次讨论”，不要调用记忆工具。');
    const beforeRestart = requests;
    await server.close(); server=await serve(config,serverOptions);
    assert.equal(requests,beforeRestart,'history_restart_no_model');
    const {status:recalled,answer} = await chat(alpha,'这个项目之前的对话里，我们为 NEBULA_842 选择了什么数据库？请检索历史并读取原消息后回答。');
    const search = recalled.messages.find(message=>message.role==='toolResult' && message.toolName==='history_search' && !message.isError);
    const read = recalled.messages.find(message=>message.role==='toolResult' && message.toolName==='history_read' && !message.isError);
    assert(search && read,'history_tools_succeeded');
    const original = JSON.parse(read.content.filter(block=>block.type==='text').map(block=>block.text).join(''));
    assert.equal(original.taskId,source.id,'history_original_task');
    assert.match(original.text,/NEBULA_842.*SQLite/,'history_original_text');
    assert.match(answer,/SQLite/i,'history_answer');
    assert.equal(recalled.goal,undefined);
    evidence.projectHistory={sourceTaskId:source.id,recalledTaskId:recalled.id,entryId:original.entryId,sourceRead:true,answerVerified:true,goalCreated:false,requests};
  });
  await check('F11-chat-reminder-management',async()=>{
    const {status:created}=await chat(alpha,'请每周二纽约时间下午 5 点提醒我检查合成周报，只保存通知提醒。');
    const reminder=(await server.runtime.routines.list()).find(rule=>rule.action==='notify' && rule.schedule.kind==='weekly');
    assert(reminder && reminder.schedule.kind==='weekly','managed_weekly_saved');
    assert.equal(reminder.schedule.weekday,2);assert.equal(reminder.schedule.time,'17:00');assert.equal(reminder.schedule.timeZone,'America/New_York');
    assert.equal(created.goal,undefined);
    const beforeRestart=requests;
    await server.close();server=await serve(config,serverOptions);assert.equal(requests,beforeRestart);
    await server.runtime.followUp(created.id,'把刚才的提醒改成每天纽约时间下午 6 点，内容改为“检查更新后的合成报告”。','manage-reminder');
    const updated=await until(()=>server.runtime.status(created.id),status=>status.status==='answered' && status.submission?.requestId==='user:manage-reminder',90_000);
    assert.equal(updated.goal,undefined);
    assert(updated.messages.some(message=>message.role==='toolResult' && message.toolName==='reminder_update' && !message.isError),'managed_update_succeeded');
    const edited=(await server.runtime.routines.list()).find(rule=>rule.id===reminder.id)!;
    assert.deepEqual(edited.schedule,{kind:'daily',time:'18:00',timeZone:'America/New_York'});assert.equal(edited.revision,2);
    assert.match(edited.objective,/检查更新后的合成报告/);
    assert.equal((await server.runtime.routines.list()).length,1,'managed_update_keeps_identity');
    await server.runtime.followUp(created.id,'取消这条每天的提醒。','cancel-managed-reminder');
    const cancelled=await until(()=>server.runtime.status(created.id),status=>status.status==='answered' && status.submission?.requestId==='user:cancel-managed-reminder',90_000);
    assert.equal(cancelled.goal,undefined);assert.equal((await server.runtime.routines.list()).find(rule=>rule.id===reminder.id)?.status,'cancelled');
    evidence.reminderManagement={routineId:reminder.id,weeklyCreated:true,dailyUpdated:true,originalIdKept:true,cancelled:true,goalCreated:false,requests};
  });
  await check('F11-chat-reminder',async()=>{
    const due = Date.parse('2026-12-01T22:00:00Z');
    const {status:created} = await chat(alpha,'请在 2026 年 12 月 1 日纽约时间下午 5 点提醒我检查合成报告。只保存通知提醒。');
    const reminder = (await server.runtime.routines.list()).find(rule=>rule.action==='notify' && rule.schedule.kind==='once');
    assert(reminder && reminder.schedule.kind==='once','chat_reminder_saved');
    assert.equal(Date.parse(reminder.schedule.at),due,'chat_reminder_time');
    assert(created.messages.some(message=>message.role==='toolResult' && message.toolName==='reminders_info' && !message.isError),'chat_reminder_clock_read');
    assert(created.messages.some(message=>message.role==='toolResult' && message.toolName==='reminder_create' && !message.isError),'chat_reminder_tool_succeeded');
    const beforeRestart = requests;
    await server.close(); server=await serve(config,serverOptions);
    assert.equal(requests,beforeRestart,'chat_reminder_restart_no_model');
    await server.runtime.followUp(created.id,'取消刚才检查合成报告的提醒。','cancel-chat-reminder');
    const cancelled = await until(()=>server.runtime.status(created.id),status=>status.status==='answered' && status.submission?.requestId==='user:cancel-chat-reminder',90_000);
    assert.equal(cancelled.goal,undefined);
    assert(cancelled.messages.some(message=>message.role==='toolResult' && message.toolName==='reminder_cancel' && !message.isError),'chat_reminder_cancel_succeeded');
    assert.equal((await server.runtime.routines.list()).find(rule=>rule.id===reminder.id)?.status,'cancelled');
    routineClock.advanceTo(due);
    assert(!(await server.runtime.notifications()).some(event=>event.routineId===reminder.id));
    evidence.chatReminder={routineId:reminder.id,at:new Date(due).toISOString(),saved:true,cancelled:true,goalCreated:false,requests};
  });
  await check('F11-F12-reminder-and-change-aware-routine',async()=>{
    const parsed = await models.complete(model, {
      messages: [{role:'user',timestamp:Date.now(),content:'Remind me at 5 PM in New York on December 1, 2026. Call reminder_time with the corresponding ISO 8601 datetime and its UTC offset.'}],
      tools: [{name:'reminder_time',description:'Return a single reminder schedule with an explicit UTC offset.',
        parameters:Type.Object({kind:Type.Literal('once'),at:Type.String()})}],
    }, {maxTokens:512,toolChoice:{type:'function',function:{name:'reminder_time'}}});
    const proposal = parsed.content.find(part=>part.type==='toolCall' && part.name==='reminder_time');
    evidence.reminderParse = {stopReason:parsed.stopReason,tokens:parsed.usage.totalTokens,toolReturned:!!proposal};
    assert(proposal?.type==='toolCall');
    const schedule = proposal.arguments;
    const due = Date.parse('2026-12-01T22:00:00Z');
    assert.equal(schedule.kind,'once');
    assert.equal(typeof schedule.at,'string');
    assert(/(?:Z|[+-]\d{2}:\d{2})$/.test(schedule.at as string));
    assert.equal(Date.parse(schedule.at as string),due);
    evidence.reminder = {parsedAt:new Date(due).toISOString(),parseTokens:parsed.usage.totalTokens};
    const reminder = await client.request<Routine>('/v1/routines','POST',{action:'notify',objective:'Synthetic reminder',schedule});
    await until(async()=>routineClock.waitingAt(due),Boolean);
    assert(!(await server.runtime.notifications()).some(event=>event.routineId===reminder.id));
    routineClock.advanceTo(due);
    const reminderEvents = await until(()=>server.runtime.notifications(),events=>events.some(event=>event.routineId===reminder.id));
    assert.deepEqual(reminderEvents.filter(event=>event.routineId===reminder.id).map(event=>event.at),[due]);
    assert.deepEqual((await server.runtime.routines.history(reminder.id)).filter(event=>event.status==='notified').map(event=>event.scheduledAt),[new Date(due).toISOString()]);
    evidence.reminder = {...(evidence.reminder as object),routineId:reminder.id,deliveredAt:new Date(due).toISOString(),notifications:1};

    const inputPath = join(alpha,'reports','inventory.txt');
    await mkdir(join(alpha,'reports'),{recursive:true});
    const rule = await client.request<Routine>('/v1/routines','POST',{
      action:'task',workspace:alpha,schedule:{kind:'daily',time:'17:00',timeZone:'America/New_York'},notifyOnChange:true,
      objective:'Use exactly these three tools in order. 1. Call read with path "reports/inventory.txt". Each nonempty line is already the name of a directory entry. 2. Call write with path "routine-summary.json" and content containing the compact JSON object {"entries":[...names from the file in order...]}. 3. Call task_submit with summary "Inventory complete" and artifacts ["routine-summary.json"]. No shell, directory listing, additional files, or further reads are required.',
      acceptance:[{type:'file_exists',path:'routine-summary.json'}],
    });
    const occurrences = [];
    for(const [day,entries,notifications] of [[2,['alpha'],1],[3,['alpha'],1],[4,['alpha','beta'],2]] as const) {
      const input = entries.join('\n');
      await writeFile(inputPath,input);
      const at = Date.UTC(2026,11,day,22);
      await until(async()=>routineClock.waitingAt(at),Boolean);
      routineClock.advanceTo(at);
      const history = await until(()=>server.runtime.routines.history(rule.id),rows=>rows.some(row=>Date.parse(row.scheduledAt)===at && ['started','failed','budget_exhausted'].includes(row.status)));
      const occurrence = history.find(row=>Date.parse(row.scheduledAt)===at && row.status==='started');
      assert(occurrence?.taskId,'expected a task created by the Pi routine');
      tasks.add(occurrence.taskId);
      const status = await until(()=>server.runtime.status(occurrence.taskId!),row=>['completed','failed','budget_limited','waiting_user','needs_attention'].includes(row.status),90_000);
      assert.equal(status.status,'completed');
      assert.deepEqual(JSON.parse(await readFile(join(alpha,'routine-summary.json'),'utf8')),{entries:[...entries]});
      assert.equal(await readFile(inputPath,'utf8'),input);
      const delivered = (await server.runtime.notifications()).filter(event=>event.routineId===rule.id && event.event==='completed');
      assert.equal(delivered.length,notifications);
      const {estimatedCostUsd,priceKnown} = status.budget;
      occurrences.push({id:occurrence.id,taskId:occurrence.taskId,scheduledAt:occurrence.scheduledAt,notifications,
        usage:{...status.budget,estimatedCostUsd:priceKnown ? estimatedCostUsd : null}});
    }
    evidence.routine = {ruleId:rule.id,occurrences};
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
  if(credentialService) {credentialService.closeAllConnections();await new Promise<void>(done=>credentialService.close(()=>done()));}
  const report={at:new Date().toISOString(),model:modelId,customCatalog:!original,selection:selectedCases,fullSuite:selectedCases.length===0,passed:Object.values(results).every(result=>result.passed),maxRequests,modelRequests:requests,maxOutputTokensPerRequest:1536,estimatedCostUsd:null,results,evidence,tasks:usage,totalTaskTokens:usage.reduce((sum,item)=>sum+item.tokens,0),note:'Task ledger includes owned workers; the standalone reminder parsing call is additionally bounded by the request counter. Deterministic kill/clock/permission tests are separate.'};
  await writeFile(join(directory,'result.json'),JSON.stringify(report,null,2)+'\n');
  console.log(`Evidence: ${join(directory,'result.json')}`);
  console.log(JSON.stringify({passed:report.passed,requests,totalTaskTokens:report.totalTaskTokens}));
  if(!report.passed) process.exitCode=1;
}
