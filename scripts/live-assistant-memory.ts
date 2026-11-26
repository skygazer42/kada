import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';
import { mkdir,readFile,writeFile } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { createServer } from 'node:net';
import { Agent, request, createServer as createHttpServer } from 'node:http';
import type { request as HttpsRequest } from 'node:https';
import { createHash,randomUUID } from 'node:crypto';
import { createModels,createProvider,getCurrentTools,Type, type TranscriptContext } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { defineExtension, hook, ToolTask } from '@earendil-works/pi-durable';
import { cloudModels } from '../src/models.js';
import { serve } from '../src/server.js';
import { createClient, type TaskStatus } from '../src/client.js';
import { ChatSession } from '../src/chat.js';
import { conversationAnswer } from '../src/conversation.js';
import type { Routine } from '../src/routines.js';
import { fakeRoutineClock, until } from '../test/helpers.js';
import { startMcpProposalService } from '../test/fixtures/mcp-proposal-service.js';

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
const proposalModel = process.env.KADA_LIVE_CASES === 'T05-model-proposals' ? template : undefined;
const chatChoosesThreadModel = process.env.KADA_LIVE_CASES === 'T09-thread-models-chat';
const threadModelTest = chatChoosesThreadModel || process.env.KADA_LIVE_CASES === 'T09-thread-models';
const otherModel = proposalModel ?? (threadModelTest ? template : undefined);
const native = openAICompletionsApi(),deadline = AbortSignal.timeout(12*60_000);
const maxRequests = ['A02-chat-assistants','T08-thread-reports'].includes(process.env.KADA_LIVE_CASES ?? '') ? 16 : threadModelTest || process.env.KADA_LIVE_CASES === 'K01-application-credential' ? 10 : ['F11-chat-reminder-management','W01-chat-work-items','W02-work-item-planning','A01-named-assistant','T03-local-threads'].includes(process.env.KADA_LIVE_CASES ?? '') ? 12 : ['F11-chat-reminder','H01-project-history','D01-mcp-discovery','T01-project-tasks','T02-project-catalog','T04-workspace-snapshots','T05-model-proposals','T06-mcp-proposals','T07-mcp-scope-proposals','Q01-structured-question'].includes(process.env.KADA_LIVE_CASES ?? '') ? 8 : 32;
let requests=0;
let onModelRequest: (() => void) | undefined;
const threadDispatches: string[] = [];
const options = (input:any, selected: string, context: TranscriptContext) => {
  assert(requests < maxRequests,'Live request limit reached.');requests++;
  const request = {...input,maxTokens:Math.min(input?.maxTokens ?? 1536,1536),signal:AbortSignal.any([deadline,...(input?.signal ? [input.signal] : [])])};
  if (!threadModelTest) return request;
  threadDispatches.push(selected);
  if (selected !== template.id) return request;
  const stage = getCurrentTools(context.messages).some(tool => tool.name === 'task_submit') ? 'task_submit' : 'task_prepare';
  const done = context.messages.some(message => message.role === 'toolResult' && message.toolName === stage && !message.isError);
  return { ...request, toolChoice: done ? 'none' : { type: 'function', function: { name: stage } } };
};
function observe<T>(stream: T): T {
  onModelRequest?.();
  return stream;
}
const models = createModels();
let protectedMarker: string | undefined;
let onModelContext: ((context: TranscriptContext) => void) | undefined;
function protectedContext(context: TranscriptContext) { assert(!protectedMarker || !JSON.stringify(context).includes(protectedMarker),'protected_value_absent_from_model_context'); onModelContext?.(context); }
models.setProvider(createProvider({id:'siliconflow',models:otherModel && otherModel.id !== model.id ? [model, otherModel] : [model],baseUrl:model.baseUrl,
  auth:{apiKey:{name:'SiliconFlow live validation',resolve:async()=>({auth:{apiKey}})}},
  api:{stream:(selected,context,config)=>{protectedContext(context);return observe(native.stream(selected,context,options(config, selected.id, context)));},streamSimple:(selected,context,config)=>{protectedContext(context);return observe(native.streamSimple(selected,context,options(config, selected.id, context)));}}}));
const directory = resolve('.harness/live-assistant-memory',randomUUID());
const home = join(directory,'home'),alpha=join(directory,'alpha'),beta=join(directory,'beta');
await Promise.all([home,join(directory,'.git'),join(alpha,'.git'),join(beta,'.git')].map(path=>mkdir(path,{recursive:true})));
await writeFile(join(alpha,'AGENTS.md'),'日报回复语言 language 偏好：中文。\n\n日报项目内部代号是 COMET_7391。');
await writeFile(join(beta,'AGENTS.md'),'日报回复语言 language 偏好：英文。');
const socket=createServer();await new Promise<void>(done=>socket.listen(0,'127.0.0.1',done));
const port=(socket.address() as {port:number}).port;await new Promise<void>(done=>socket.close(()=>done()));
const longLiveCases = ['A02-chat-assistants', 'A03-assistant-collaboration'];
const config={dataDir:join(directory,'state'),port,model:{provider:'siliconflow',modelId},maxSubagents:2,maxDurationMs:process.env.KADA_LIVE_CASES === 'T08-thread-reports' ? 240_000 : 180_000,maxTotalTokens:longLiveCases.includes(process.env.KADA_LIVE_CASES ?? '') ? 180_000 : 100_000,review:false,web:false,discovery:true,
  workspaceSnapshots:process.env.KADA_LIVE_CASES === 'T04-workspace-snapshots'};
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
  if (selectedCases.includes('A03-assistant-collaboration')) await check('A03-assistant-collaboration', async () => {
    const checkpoints: Record<string, unknown> = { tokenLimit: config.maxTotalTokens, durationLimitMs: config.maxDurationMs };
    evidence.assistantCollaboration = checkpoints;
    const receipt = await server.runtime.assistants.create({ workspace: alpha, name: 'Sample Reviewer',
      instructions: 'For the initial assignment, use assistant_ask to ask the owner to select blue or green before reading anything. On the answer turn, return the exact chosen word. On explicit rework, recall the owner answer from your conversation history, write it as the sole content of team-result.txt, call assistant_attach for that file, and return the word.',
      tools: ['assistant_ask', 'write', 'assistant_attach'] });
    const assistant = { id: receipt.id, revision: receipt.revision };
    const task = await client.request<{ id: string }>('/v1/tasks', 'POST', { workspace: alpha, confirmed: true, collaborators: [assistant],
      objective: `Use assistant_assign in standing mode to give Sample Reviewer (${assistant.id}, revision ${assistant.revision}) one assignment: ask the owner to select a colour. Finish your turn. On ASSISTANT_QUESTION, let the owner reply and finish that turn. On ASSISTANT_REPORT for the initial work ID, use assistant_result and then assistant_rework on that work. Tell the reviewer to write only the chosen English word from its saved answer to team-result.txt and attach the file. Do not include the colour in the rework. Finish your turn. On ASSISTANT_REPORT for the separate rework ID, use assistant_result and read team-result.txt, then call task_submit with team-result.txt as the only artifact. Only the reviewer should write that file.`,
      acceptance: [{ type: 'file_contains', path: 'team-result.txt', text: 'blue' }] });
    tasks.add(task.id);
    const observeTask = async () => {
      const status = await server.runtime.status(task.id);
      checkpoints.lastStatus = status.status;
      checkpoints.submission = status.submission?.status;
      checkpoints.workCount = status.assistantWork.length;
      return status;
    };
    const waiting = await until(observeTask, status =>
      ['waiting_assistant', 'waiting_user', 'failed', 'budget_limited', 'needs_attention'].includes(status.status), 120_000);
    const originalWork = waiting.assistantWork[0];
    const question = originalWork?.questions[0];
    assert.equal(waiting.status, 'waiting_assistant');
    assert(originalWork && question && !question.answer);
    await server.close();
    server = await serve(config, serverOptions);
    const terminalErrors: string[] = [];
    const terminal = new ChatSession(client, event => { if (event.kind === 'error') terminalErrors.push(event.text); }, alpha);
    await terminal.attach(task.id);
    await terminal.handle(`/reply-assistant ${originalWork.id} ${question.id} blue`);
    assert.equal(terminalErrors.length, 0);
    checkpoints.restartedAndAnswered = true;
    const done = await until(observeTask, status =>
      ['completed', 'waiting_user', 'failed', 'budget_limited', 'needs_attention'].includes(status.status), 150_000);
    const [first, rework] = done.assistantWork;
    assert.equal(done.status, 'completed');
    assert.equal(done.deadlineAt, waiting.deadlineAt);
    assert.equal(done.assistantWork.length, 2);
    assert(first && rework && rework.outputs.length === 1);
    assert.equal(first.id, originalWork.id);
    assert.equal(first.questions[0]?.id, question.id);
    assert.equal(rework.reworkOf, first.id);
    assert.equal(rework.conversationId, first.conversationId);
    assert.doesNotMatch(rework.brief, /\bblue\b/i);
    assert(rework.result && first.result);
    const output = rework.outputs[0]!;
    const bytes = await readFile(output.path);
    assert.equal(bytes.toString().trim(), 'blue');
    assert.equal(createHash('sha256').update(bytes).digest('hex'), output.sha256);
    assert.deepEqual(await readFile(join(alpha, 'team-result.txt')), bytes);
    assert((await server.runtime.artifacts(task.id)).some(file => file.state === 'verified' && file.sha256 === output.sha256));
    Object.assign(checkpoints, { taskId: task.id, workId: first.id, questionId: question.id, reworkId: rework.id,
      conversationId: first.conversationId, pinnedRevision: first.assistant.revision, restartOriginalQuestion: true,
      originalDeadline: true, fixedArtifactHash: output.sha256, verifiedDelivery: true, requests });
  });
  await check('A02-chat-assistants',async()=>{
    const instructions='先阅读原始资料并引用来源。';
    const {status:created}=await chat(alpha,'请给当前项目保存一个名为“LYRA_ROLE_628 研究员”的助手配置，完整指令逐字为“'+instructions+'”，工具名单只允许 read，模型使用默认（model=null）。先用 assistant_catalog 查询 read 的实际工具名，再用 assistant_create 保存。只配置，不开始工作，不切换本会话角色，不创建任务或提醒。',config.maxDurationMs+5000);
    const roles=(await server.runtime.assistants.list(alpha)).filter(role=>role.name==='LYRA_ROLE_628 研究员');
    assert.equal(roles.length,1,'chat_role_single_identity');const role=roles[0]!;
    assert.equal((await server.runtime.assistants.get(role.id)).instructions,instructions);assert.deepEqual(role.tools,['read']);assert.equal(role.model,null);
    const beforeRestart=requests;await server.close();server=await serve(config,serverOptions);assert.equal(requests,beforeRestart,'chat_role_restart_no_model');
    await server.runtime.followUp(created.id,'请先 assistant_read 读取 LYRA_ROLE_628 研究员的完整原指令，再仅在末尾追加“结果用中文。”，保留原句与工具和模型。用原 ID/当前修订修改配置；不开始任务或切换本会话。','chat-role-edit');
    const edited=await until(()=>server.runtime.status(created.id),row=>row.submission?.requestId==='user:chat-role-edit' && ['answered','failed','budget_limited','waiting_user'].includes(row.status),config.maxDurationMs+5000);
    assert.equal(edited.status,'answered');assert.equal(edited.goal,undefined);assert.equal(edited.assistant,undefined);
    const amended=await server.runtime.assistants.get(role.id);assert.equal(amended.instructions,instructions+'结果用中文。');assert.deepEqual(amended.tools,['read']);assert.equal(amended.model,null);
    await server.runtime.followUp(created.id,'请把刚才的 LYRA_ROLE_628 研究员配置归档，保留记录，不取消或启动任何工作。','chat-role-archive');
    const archived=await until(()=>server.runtime.status(created.id),row=>row.submission?.requestId==='user:chat-role-archive' && ['answered','failed','budget_limited','waiting_user'].includes(row.status),config.maxDurationMs+5000);
    assert.equal(archived.status,'answered');assert.equal(archived.goal,undefined);assert.equal((await server.runtime.assistants.get(role.id)).archived,true);
    await server.runtime.followUp(created.id,'请恢复刚才已归档的 LYRA_ROLE_628 研究员配置（archived=false），只恢复同一条记录，然后 assistant_read 回读完整设置；不开始工作，不切换当前角色。','chat-role-restore');
    const done=await until(()=>server.runtime.status(created.id),row=>row.submission?.requestId==='user:chat-role-restore' && ['answered','failed','budget_limited','waiting_user'].includes(row.status),config.maxDurationMs+5000);
    assert.equal(done.status,'answered');assert.equal(done.goal,undefined);assert.equal(done.assistant,undefined);
    const final=await server.runtime.assistants.get(role.id);assert.equal(final.archived,false);assert.equal(final.instructions,instructions+'结果用中文。');assert.equal(final.revision,4);
    assert.equal((await server.runtime.assistants.list(alpha)).filter(row=>row.name==='LYRA_ROLE_628 研究员').length,1);
    assert.equal((await server.runtime.list()).length,1,'chat_role_no_extra_task');
    const calls=done.messages.filter(message=>message.role==='toolResult');
    assert.equal(calls.filter(message=>message.toolName==='assistant_create' && !message.isError).length,1);
    assert.equal(calls.filter(message=>message.toolName==='assistant_update' && !message.isError).length,3);
    assert(calls.filter(message=>message.toolName==='assistant_read' && !message.isError).length>=2);
    assert(calls.some(message=>message.toolName==='assistant_catalog' && !message.isError));
    assert(!calls.some(message=>/task_prepare|delegate|reminder_create/.test(message.toolName)),'chat_role_no_goal_or_dispatch');
    evidence.chatAssistants={assistantId:role.id,chatId:created.id,originalIdKept:true,instructionsPreserved:true,archivedAndRestored:true,restartNoModel:true,
      finalRevision:final.revision,createCalls:1,updateCalls:3,goalCreated:false,currentRoleChanged:false,extraTasks:0,requests};
  });
  await check('A01-named-assistant',async()=>{
    const oldMarker='ROLE_LIVE_READER_731', newMarker='ROLE_LIVE_WRITER_936';
    let expected=oldMarker, canWrite=false, contexts=0;
    onModelContext=context=>{
      const system=JSON.stringify(context.messages.filter(message=>message.role==='system'));
      if(system.includes('context summarization assistant')) return;
      assert(system.includes(expected),'role_context_original_or_new');
      assert(!system.includes(expected===oldMarker ? newMarker : oldMarker),'role_context_other_revision_absent');
      const names=getCurrentTools(context.messages).map(tool=>tool.name);
      assert(!names.includes('bash'),'role_bash_never_enabled');
      assert.equal(names.includes('write'),canWrite,'role_write_only_after_confirmation');contexts++;
    };
    try {
      const role=await server.runtime.assistants.create({workspace:alpha,name:'合成阅读助手',instructions:'你是合成阅读助手。每次回复以 '+oldMarker+' 开头。按当前用户要求工作；配置本身不授权执行。',model:{provider:'siliconflow',modelId},tools:['read']});
      const source=await server.runtime.create('请用两句介绍你的职责，不用工具，不创建任务或提醒。',alpha,[],{chat:true,assistant:{id:role.id,revision:1}});tasks.add(source.id);
      const answered=await until(()=>server.runtime.status(source.id),row=>['answered','failed','waiting_user','budget_limited'].includes(row.status),config.maxDurationMs+5000);
      assert.equal(answered.status,'answered');assert.equal(answered.goal,undefined);
      assert(answered.messages.map(conversationAnswer).some(text=>text?.includes(oldMarker)),'role_marker_in_reply');
      await server.runtime.assistants.update(role.id,{revision:1,name:'合成写作助手',instructions:'你是合成写作助手。每次回复以 '+newMarker+' 开头。按当前任务说明、用户确认和工具范围交付。',tools:['read','write']});
      const beforeRestart=requests;await server.close();server=await serve(config,serverOptions);
      assert.equal(requests,beforeRestart,'role_restart_no_new_request');
      await server.runtime.followUp(source.id,'请只复述你的固定角色标记和当前职责，不执行工作。','role-original');
      const original=await until(()=>server.runtime.status(source.id),row=>row.submission?.requestId==='user:role-original' && ['answered','failed','waiting_user','budget_limited'].includes(row.status),config.maxDurationMs+5000);
      assert.equal(original.status,'answered');assert.equal(original.goal,undefined);assert.equal(original.assistant?.revision,1);
      assert.equal(original.assistant?.name,'合成阅读助手');assert(original.messages.map(conversationAnswer).at(-1)?.includes(oldMarker));
      expected=newMarker;
      const task=await server.runtime.create('在当前项目直接使用相对路径 role-result.txt，内容必须逐字为 ROLE_ARTIFACT_519，不加换行，也不要其他产物。先用 task_prepare 提出说明、scope、inspect 核验标准并等待确认；checks 使用 file_contains。总预算明确设为 maxDurationMs=180000、maxTotalTokens=100000、maxEstimatedCostUsd=1。确认后直接 write、必要的 read，再 task_submit；无需查询工作目录，也不登记 task_plan 或 task_checkpoint。',alpha,[],{chat:true,assistant:{id:role.id,revision:2}});tasks.add(task.id);
      const waiting=await until(()=>server.runtime.status(task.id),row=>['awaiting_confirmation','failed','waiting_user','budget_limited'].includes(row.status),config.maxDurationMs+5000);
      assert.equal(waiting.status,'awaiting_confirmation');assert.equal(waiting.assistant?.revision,2);
      assert.equal(waiting.goal?.brief?.budget.maxDurationMs,180_000,'role_requested_time_budget');
      assert.equal(waiting.goal?.brief?.budget.maxTotalTokens,100_000,'role_requested_token_budget');
      assert.equal(waiting.goal?.brief?.budget.maxEstimatedCostUsd,1,'role_requested_cost_budget');
      await assert.rejects(readFile(join(alpha,'role-result.txt')),{code:'ENOENT'});
      canWrite=true;await server.runtime.confirm(task.id,waiting.goal!.brief!.revision,waiting.briefDigest!);
      const done=await until(()=>server.runtime.status(task.id),row=>['completed','failed','blocked','needs_attention','waiting_user','budget_limited'].includes(row.status),config.maxDurationMs+5000);
      assert.equal(done.status,'completed');assert.equal(await readFile(join(alpha,'role-result.txt'),'utf8'),'ROLE_ARTIFACT_519');
      assert.equal(done.assistant?.revision,2);assert.equal(done.model.modelId,modelId);
      assert.equal(done.messages.filter(message=>message.role==='toolResult' && message.toolName==='write' && !message.isError).length,1);
      evidence.namedAssistant={assistantId:role.id,originalChatId:source.id,writerTaskId:task.id,oldRevisionRetained:1,newRevision:2,originalChatGoal:false,restartNoModel:true,
        confirmedOriginalBrief:true,artifactExact:true,writeCalls:1,bashOffered:false,roleContextChecks:contexts,requests};
    } finally {onModelContext=undefined;}
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
  if (selectedCases.includes('T07-mcp-scope-proposals')) await check('T07-mcp-scope-proposals', async () => {
    const fixture = await startMcpProposalService();
    const checkpoints: Record<string, unknown> = {};
    evidence.mcpProjectScopeProposal = checkpoints;
    try {
      const connection = 'scope-demo', path = `/v1/settings/mcp/${connection}`;
      await client.request('/v1/settings/mcp', 'POST', { id: connection, transport: 'http', url: fixture.address });
      const probe = await client.request<{ revision: string; test?: { status: string } }>(path + '/test', 'POST', {});
      assert.equal(probe.test?.status, 'ok');
      await client.request(path + '/enable', 'POST', { revision: probe.revision, tools: ['status'] });
      await client.request('/v1/settings/mcp/project', 'PUT', { workspace: alpha, tools: [{ id: connection, tool: 'status' }] });
      const connectionsBefore = fixture.methods.length;
      const events: string[] = [], term = new ChatSession(client, event => events.push(event.text), alpha);
      await term.handle('请用 mcp_settings_catalog 查看项目工具范围，再用 propose_project_mcp_tools 建议设为空数组，供我确认。无需调用任何业务工具。');
      const source = term.taskId!;
      tasks.add(source);
      const original = await until(() => server.runtime.status(source), status => status.messages.some(message =>
        message.role === 'toolResult' && message.toolName === 'propose_project_mcp_tools' && !message.isError), 100_000);
      await term.poll();
      assert(events.some(text => text.includes('/mcp-proposals')));
      const [draft] = await server.runtime.mcpSettingsProposals(source);
      assert(draft && 'tools' in draft && draft.state === 'pending');
      assert.deepEqual(draft.effective, []);
      assert.deepEqual(draft.previous, [{ id: connection, tool: 'status' }]);
      assert.deepEqual(original.mcpPins?.[0]?.tools, ['status']);
      await term.handle(`/apply-mcp ${draft.id}`);
      assert.deepEqual(await server.runtime.mcp.projectTools(alpha), []);
      assert.deepEqual((await server.runtime.mcp.pins(beta))[0]?.tools, ['status']);
      assert.deepEqual((await server.runtime.status(source)).mcpPins?.[0]?.tools, ['status']);
      const next = await chat(alpha, '请直接回复 READY。');
      assert.deepEqual(next.status.mcpPins, []);
      assert.equal(fixture.methods.length, connectionsBefore);
      Object.assign(checkpoints, { proposalSaved: true, ownerApplied: true, oldTaskPinned: true, otherProjectUnchanged: true,
        newTaskHadEmptyScope: true, mcpNetworkCallsDuringChange: fixture.methods.length - connectionsBefore, requests });
    } finally { await fixture.close(); }
  });
  if (selectedCases.includes('T06-mcp-proposals')) await check('T06-mcp-proposals', async () => {
    const fixture = await startMcpProposalService();
    const checkpoints: Record<string, unknown> = {};
    evidence.mcpConnectionProposal = checkpoints;
    try {
      const events: string[] = [], term = new ChatSession(client, event => events.push(event.text), alpha);
      await term.handle(`请用 propose_mcp_connection 建议一个 HTTP MCP。连接 ID 为 proposal-demo，地址为 ${fixture.address}。由我决定是否登记。`);
      const source = term.taskId!;
      tasks.add(source);
      await until(() => server.runtime.status(source), status => status.messages.some(message =>
        message.role === 'toolResult' && message.toolName === 'propose_mcp_connection' && !message.isError), 100_000);
      await term.poll();
      assert(events.some(text => text.includes('/mcp-proposals')));
      const [draft] = await server.runtime.mcpConnectionProposals(source);
      assert(draft?.state === 'pending');
      assert.equal(draft.connectionId, 'proposal-demo');
      assert.equal(draft.endpoint, fixture.address);
      assert.deepEqual(await server.runtime.mcp.list(), []);
      checkpoints.proposed = true;
      await term.handle(`/apply-mcp ${draft.id}`);
      assert.deepEqual(fixture.methods, []);
      assert.equal((await server.runtime.mcp.list())[0]?.enabled, false);
      checkpoints.registeredWithoutNetwork = true;
      const path = `/v1/settings/mcp/${draft.connectionId}`;
      const probe = await client.request<{ revision: string; test?: { status: string } }>(path + '/test', 'POST', {});
      assert.equal(probe.test?.status, 'ok');
      await client.request(path + '/enable', 'POST', { revision: probe.revision, tools: ['status'] });
      await client.request('/v1/settings/mcp/project', 'PUT', { workspace: alpha, tools: [{ id: draft.connectionId, tool: 'status' }] });
      const task = await client.request<{ id: string }>('/v1/tasks', 'POST', { workspace: alpha, confirmed: true,
        objective: 'Use the enabled tool from the proposal-demo MCP server once to read the sample status. Use the actual tool, read its result, then submit a short text result with task_submit.' });
      tasks.add(task.id);
      const status = await until(() => server.runtime.status(task.id), state => state.messages.some(message => message.role === 'toolResult' &&
        message.toolName.startsWith('mcp_proposal-demo_status_') && !message.isError && JSON.stringify(message.content).includes('PROPOSAL_TOOL_RESULT')), 100_000);
      assert.deepEqual(status.mcpPins?.find(pin => pin.id === draft.connectionId)?.tools, ['status']);
      assert.deepEqual((await server.runtime.status(source)).mcpPins, []);
      if (status.status !== 'completed') await server.runtime.cancel(task.id);
      Object.assign(checkpoints, { providerToolCalled: true, originalChatScopePreserved: true, testedTools: ['status'],
        toolCalls: fixture.methods.filter(method => method === 'tools/call').length, requests });
    } finally { await fixture.close(); }
  });
  if (proposalModel) await check('T05-model-proposals', async () => {
    const checkpoints: Record<string, unknown> = {};
    evidence.projectModelProposal = checkpoints;
    const original = { provider: 'siliconflow', modelId };
    const chosen = { provider: 'siliconflow', modelId: proposalModel.id };
    assert.notEqual(original.modelId, chosen.modelId);
    const events: string[] = [], terminal = new ChatSession(client, event => events.push(event.text), alpha);
    await terminal.handle(`请用 propose_model 建议把本项目未来会话的默认模型设为 ${chosen.modelId}，provider 用 siliconflow。理由写为轻量项目试用。将决定留给我。`);
    const sourceId = terminal.taskId!;
    tasks.add(sourceId);
    const status = await until(() => server.runtime.status(sourceId), state => state.messages.some(message =>
      message.role === 'toolResult' && message.toolName === 'propose_model' && !message.isError), 100_000);
    await terminal.poll();
    assert(events.some(text => text.includes('/model-proposals')));
    assert.equal(status.goal, undefined);
    const [proposal] = await server.runtime.projectModelProposals(sourceId);
    assert(proposal?.state === 'pending');
    assert.deepEqual(proposal.model, chosen);
    assert.deepEqual(await server.runtime.providers.selected(original, alpha), original);
    checkpoints.proposalSaved = true;
    await terminal.handle(`/apply-model ${proposal.id}`);
    assert.deepEqual(await server.runtime.providers.selected(original, alpha), chosen);
    assert.deepEqual(await server.runtime.providers.selected(original, beta), original);
    assert.deepEqual((await server.runtime.status(sourceId)).model, original);
    checkpoints.ownerApplied = true;
    const future = await chat(alpha, '请只回复 READY。');
    assert.deepEqual(future.status.model, chosen);
    Object.assign(checkpoints, { currentChatPinned: true, newChatUsedApprovedModel: true, otherProjectUnchanged: true, requests });
  });
  if (selectedCases.includes('T04-workspace-snapshots')) await check('T04-workspace-snapshots', async () => {
    const filename = 'snapshot-demo.txt', file = join(alpha, filename);
    await writeFile(file, 'BEFORE_SNAPSHOT_357');
    const edit = await client.request<{ id: string }>('/v1/tasks', 'POST', { workspace: alpha, confirmed: true,
      objective: `Use the write tool to replace ${filename} with the exact contents AFTER_SNAPSHOT_357. Then call task_submit, supplying ${filename} as the sole artifact.`,
      acceptance: [{ type: 'file_contains', path: filename, text: 'AFTER_SNAPSHOT_357' }] });
    tasks.add(edit.id);
    const edited = await until(() => server.runtime.status(edit.id), status => status.messages.some(message =>
      message.role === 'toolResult' && message.toolName === 'write' && !message.isError), 120_000);
    assert.equal((await readFile(file, 'utf8')).trim(), 'AFTER_SNAPSHOT_357');
    if (edited.status !== 'completed') await server.runtime.cancel(edit.id);
    const path = `/v1/tasks/${edit.id}/snapshots`;
    const undoPoints = await client.request<{ id: string; automatic: boolean }[]>(path);
    assert.equal(undoPoints.length, 1);
    const [saved] = undoPoints;
    assert(saved?.automatic);
    const preview = await client.request<{ version: string; changes: { path: string; action: string }[] }>(`${path}/${saved.id}/preview`);
    assert.deepEqual(preview.changes.map(change => [change.path, change.action]), [[filename, 'replace']]);
    const beforeRestore = requests;
    await server.close(); server = await serve(config, serverOptions);
    const report = await client.request<{ undoSnapshotId: string; restored: number; removed: number }>(`${path}/${saved.id}/restore`, 'POST', { version: preview.version });
    assert.equal(report.restored, 1);
    assert.equal(await readFile(file, 'utf8'), 'BEFORE_SNAPSHOT_357');
    const undo = await client.request<{ version: string }>(`${path}/${report.undoSnapshotId}/preview`);
    await client.request(`${path}/${report.undoSnapshotId}/restore`, 'POST', { version: undo.version });
    assert.equal((await readFile(file, 'utf8')).trim(), 'AFTER_SNAPSHOT_357');
    assert.equal(requests, beforeRestore);
    evidence.workspaceSnapshots = { originalFile: filename, automaticBeforeTurn: true, editVerified: true, stoppedAfterWrite: edited.status !== 'completed', previewBoundRestore: true,
      daemonRestarted: true, undoRecoveredEditedBytes: true, restoreRequests: requests - beforeRestore, requests };
  });
  if (threadModelTest) await check(chatChoosesThreadModel ? 'T09-thread-models-chat' : 'T09-thread-models', async () => {
    assert.notEqual(modelId, template.id, 'Set the source model to DeepSeek for this two-model fixture.');
    const checks: Record<string, unknown> = { dispatches: threadDispatches, childToolsSpecifiedByFixture: true };
    evidence.threadModels = checks;
    const terminal = new ChatSession(client, () => {}, alpha);
    await terminal.handle('这是合成验收的原会话。请只回复 SOURCE_READY_614。');
    const source = terminal.taskId!;
    tasks.add(source);
    checks.source = source;
    const ready = await until(() => server.runtime.status(source), state => state.status === 'answered', 95_000);
    assert.equal(ready.goal, undefined);
    assert.deepEqual([...new Set(threadDispatches)], [modelId]);
    const beforeChild = threadDispatches.length;
    const task = '纯文本报告。先 task_prepare，outcome 为“核对合成数值”，deliverables 为 ["文本"]，inputs 和 assumptions 和 questions 为空数组，scope 为 ["合成验收"]，criteria 只有 {"text":"结果是 42","method":"inspect"}。确认后直接 task_submit，summary 为 "SECOND_OPINION_42"，artifacts 为空数组，criteria 为 [{"id":1,"status":"passed","evidence":"19+23=42"}]。';
    let child: string;
    if (chatChoosesThreadModel) {
      await terminal.handle('合成验收，请先使用 list_models 搜索 Qwen2.5-7B-Instruct，再用 start_thread 开一个名为“聊天选模型”的独立任务。将目录返回的精确 provider 和 modelId 填入 model_selection，并开启 report_back。新任务是' + task + '开好后简短回复。');
      const opened = await until(() => server.runtime.status(source), state => state.messages.some(message => message.role === 'toolResult' && message.toolName === 'start_thread' && !message.isError), 155_000);
      const listing = opened.messages.find(message => message.role === 'toolResult' && message.toolName === 'list_models');
      assert(listing?.role === 'toolResult' && !listing.isError);
      const catalog = JSON.parse(listing.content.map(part => part.type === 'text' ? part.text : '').join(''));
      assert(catalog.items.some((item: {provider: string; modelId: string}) => item.provider === 'siliconflow' && item.modelId === template.id));
      const receipt = opened.messages.find(message => message.role === 'toolResult' && message.toolName === 'start_thread' && !message.isError);
      assert(receipt?.role === 'toolResult');
      const admitted = JSON.parse(receipt.content.map(part => part.type === 'text' ? part.text : '').join(''));
      assert.equal(admitted.model.modelId, template.id);
      assert.equal(admitted.thread.reportBack, true);
      child = admitted.id;
      checks.chatCatalogAndStart = true;
      await terminal.attach(child);
    } else {
      await terminal.handle(`/thread-report --model siliconflow/${template.id} 模型分流 | ${task}`);
      child = terminal.taskId!;
    }
    tasks.add(child);
    checks.child = child;
    const selected = await until(() => server.runtime.status(child), state => ['awaiting_confirmation','failed','budget_limited'].includes(state.status), 115_000);
    checks.preparation = selected.status;
    assert.equal(selected.status, 'awaiting_confirmation');
    assert.equal(selected.model.modelId, template.id);
    assert.equal(selected.goal?.confirmation, undefined);
    if (chatChoosesThreadModel) {
      assert(threadDispatches.slice(beforeChild).includes(template.id));
      await until(() => server.runtime.status(source), state => state.status === 'answered', 100_000);
    } else assert.deepEqual([...new Set(threadDispatches.slice(beforeChild))], [template.id]);
    const beforeConfirm = threadDispatches.length;
    await terminal.poll();
    await terminal.handle('/confirm');
    const delivered = await until(() => server.runtime.status(child), state => ['completed','failed','needs_attention','budget_limited'].includes(state.status), 145_000);
    checks.execution = delivered.status;
    assert.equal(delivered.status, 'completed');
    assert.match(delivered.goal?.candidate?.summary ?? '', /SECOND_OPINION_42/);
    const returned = await until(() => server.runtime.status(source), state => state.status === 'answered' && state.submission?.requestId === 'thread-report:' + child, 105_000);
    const modelsAfterConfirm = threadDispatches.slice(beforeConfirm);
    assert.deepEqual([...new Set(modelsAfterConfirm)], [template.id, modelId]);
    assert.equal(modelsAfterConfirm.at(-1), modelId);
    assert.equal(returned.model.modelId, modelId);
    assert.equal(returned.threadReports[0]?.model?.modelId, template.id);
    assert.equal(returned.threadReports[0]?.candidateId, delivered.goal?.candidate?.id);
    assert(returned.messages.map(conversationAnswer).filter(Boolean).at(-1));
    const beforeRestart = requests;
    await server.close(); server = await serve(config, serverOptions);
    assert.deepEqual((await server.runtime.status(source)).threadReports, returned.threadReports);
    assert.equal((await server.runtime.status(child)).model.modelId, template.id);
    assert.equal(requests, beforeRestart);
    Object.assign(checks, { preparationModel: template.id, executionAndReturnModels: modelsAfterConfirm, originalModel: modelId, receiptSurvivedRestart: true });
  });
  const reportThread = selectedCases.includes('T08-thread-reports');
  if (reportThread || selectedCases.includes('T03-local-threads')) await check(reportThread ? 'T08-thread-reports' : 'T03-local-threads', async () => {
    const filename = 'thread-evidence.txt', expected = 'THREAD_ARTIFACT_728';
    const checkpoints: Record<string, unknown> = {};
    evidence.localThreads = checkpoints;
    const request = `请用 start_thread 另开一个题为“独立样本”的会话。将这份任务完整传入新会话：只创建 ${filename}，内容严格为 ${expected}。首先单独调用 task_prepare，交付项是该文件，使用一个 inspect 验收标准，并设置 budget 为 {"maxEstimatedCostUsd":1,"maxDurationMs":180000,"maxTotalTokens":90000}。确认后用 write 写文件，再用 read 核对内容，最后 task_submit 附上文件和标准 1 的自检。创建会话后请回复其 ID。` +
      (reportThread ? `开启 report_back，把验收结果回传并续答这一个原会话。要求独立任务在 task_submit 的 summary 写出核验后的 ${expected}。` : '');
    const events: string[] = [], terminal = new ChatSession(client, event => events.push(event.text), alpha);
    await terminal.handle(request);
    const source = terminal.taskId!;
    tasks.add(source);
    const original = await until(() => server.runtime.status(source), status =>
      status.messages.some(message => message.role === 'toolResult' && message.toolName === 'start_thread' && !message.isError), 100_000);
    const opened = original.messages.find(message => message.role === 'toolResult' && message.toolName === 'start_thread' && !message.isError);
    assert(opened?.role === 'toolResult');
    const receipt = JSON.parse(opened.content.map(block => block.type === 'text' ? block.text : '').join(''));
    const id: string = receipt.id;
    Object.assign(checkpoints, { source, thread: id });
    tasks.add(id);
    assert.equal(original.goal, undefined);
    await terminal.poll();
    assert(events.some(text => text.includes('/attach ' + id)));
    checkpoints.terminalReceipt = true;
    const waiting = await until(() => server.runtime.status(id), state => ['awaiting_confirmation', 'failed', 'budget_limited'].includes(state.status), reportThread ? 240_000 : 100_000);
    assert.equal(waiting.status, 'awaiting_confirmation');
    assert.equal(waiting.thread?.sourceTaskId, source);
    assert.equal(waiting.thread?.title, '独立样本');
    assert.equal(waiting.thread?.openedBy, 'assistant');
    assert.equal(Boolean(waiting.thread?.reportBack), reportThread);
    assert(!waiting.goal?.confirmation);
    checkpoints.tokenLimit = waiting.goal?.brief?.budget.maxTotalTokens;
    assert.equal(checkpoints.tokenLimit, 90_000);
    await assert.rejects(readFile(join(alpha, filename)), { code: 'ENOENT' });
    await terminal.attach(id);
    await terminal.handle('/confirm');
    const done = await until(() => server.runtime.status(id), state => ['completed', 'failed', 'needs_attention', 'budget_limited'].includes(state.status), 120_000);
    checkpoints.finalExecution = done.status;
    assert.equal(done.status, 'completed');
    assert.equal((await readFile(join(alpha, filename), 'utf8')).trim(), expected);
    assert((await server.runtime.artifacts(id)).some(file => file.name === filename && file.state === 'verified'));
    if (reportThread) {
      const returned = await until(() => server.runtime.status(source), state => state.status === 'answered' &&
        state.submission?.requestId === 'thread-report:' + id && state.threadReports.length === 1, 160_000);
      assert.equal(returned.goal, undefined);
      const report = returned.threadReports[0]!;
      assert.equal(report.candidateId, done.goal?.candidate?.id);
      assert.equal(report.mode, 'resumed');
      assert.match(report.summary, new RegExp(expected));
      assert.match(returned.messages.map(conversationAnswer).filter(Boolean).at(-1) ?? '', /THREAD_ARTIFACT_728|thread-evidence\.txt/);
      await terminal.attach(source);
      assert(events.some(text => text.includes('独立工作回传') && text.includes('/attach ' + id)));
      await terminal.attach(id);
      checkpoints.returnedToOriginalConversation = true;
      checkpoints.nativeReportSubmission = returned.submission.id;
    }
    await terminal.handle('/title 已验收的独立样本');
    await terminal.handle('/archive');
    assert.equal((await server.runtime.list('archived'))[0]?.id, id);
    await server.close(); server = await serve(config, serverOptions);
    const restoredTerminal = new ChatSession(client, () => {}, alpha);
    await restoredTerminal.attach(id);
    await restoredTerminal.handle('/unarchive');
    const restored = await server.runtime.status(id);
    assert.equal(restored.submission?.id, done.submission?.id);
    assert.equal(restored.thread?.title, '已验收的独立样本');
    assert.equal(restored.thread.archivedAt, undefined);
    assert.equal(restored.budget.totalTokens, done.budget.totalTokens);
    if (reportThread) {
      const returned = await server.runtime.status(source);
      assert.equal(returned.threadReports.length, 1);
      assert.equal(returned.submission?.id, checkpoints.nativeReportSubmission);
      checkpoints.returnedReceiptSurvivedRestart = true;
    }
    Object.assign(checkpoints, { directOwnerConfirmation: true, verifiedFile: filename,
      archivedAndRestored: true, originalSubmission: true, requests });
  });
  if (selectedCases.includes('T02-project-catalog')) await check('T02-project-catalog', async () => {
    const source = await chat(alpha, '这是数据整理原会话，代号为 CATALOG_RUN。只回复已记下，不保存待办。');
    const work = await server.runtime.workItems.create({ workspace: alpha, title: 'CATALOG_TODO 校对样本', objective: '校对合成文件。' });
    const schedule = { kind: 'once' as const, at: new Date(routineClock.now() + 86_400_000).toISOString() };
    const rule = await server.runtime.routines.create({ id: 'catalog-rule', action: 'notify', workspace: alpha, objective: 'CATALOG_RULE 核对日历', schedule });
    await server.runtime.routines.create({ id: 'another-rule', action: 'notify', workspace: beta, objective: 'OTHER_PROJECT_RULE', schedule });
    const sampleSkill = join(alpha, '.agents', 'skills', 'catalog-sample');
    await mkdir(sampleSkill, { recursive: true });
    await writeFile(join(sampleSkill, 'SKILL.md'), '---\nname: catalog-sample\ndescription: 检查合成样本\n---\n\n仅供验收。');
    const answer = await chat(alpha, '帮我看当前项目的工作总览。用空对象 {} 调用 project_catalog，读取运行、待办、规则和可用 Skills 的首页，再简要列出四类结果。只查询。');
    const lookup = answer.status.messages.find(message => message.role === 'toolResult' && message.toolName === 'project_catalog' && !message.isError);
    assert(lookup?.role === 'toolResult');
    const payload = lookup.content.map(block => block.type === 'text' ? block.text : '').join('');
    const result = JSON.parse(payload);
    assert(result.runs.items.some((item: { id: string }) => item.id === source.status.id));
    assert(result.work_items.items.some((item: { id: string }) => item.id === work.id));
    assert.deepEqual(result.routines.items.map((item: { id: string }) => item.id), [rule.id]);
    assert(result.skills.items.some((item: { name: string }) => item.name === 'catalog-sample'));
    assert.doesNotMatch(payload, /OTHER_PROJECT_RULE/);
    assert.match(answer.answer, /CATALOG_TODO|校对样本/);
    assert.equal((await server.runtime.workItems.get(work.id)).revision, work.revision);
    assert.equal((await server.runtime.status(source.status.id)).status, 'answered');
    evidence.projectCatalog = { originalRun: true, originalWorkItem: true, originalRule: true, skill: 'catalog-sample', otherProjectExcluded: true, goalCreated: false, requests };
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
    assert(search && read?.role==='toolResult','history_tools_succeeded');
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
