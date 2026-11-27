import assert from 'node:assert/strict';
import {createServer, type Server} from 'node:http';
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createInterface} from 'node:readline';
import {parseArgs} from 'node:util';
import {promisify} from 'node:util';
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import type {CallToolResult} from '@modelcontextprotocol/sdk/types.js';
import {BACKGROUND_CONTEXT} from '@earendil-works/chord/context';
import {createModels,createProvider,fauxProvider,fauxAssistantMessage,fauxToolCall,type Models,type TranscriptContext} from '@earendil-works/pi-ai';
import {openAICompletionsApi} from '@earendil-works/pi-ai/api/openai-completions.lazy';
import {defineExtension,hook,ToolTask,type ToolExecutionApi,type JsonObject} from '@earendil-works/pi-durable';
import {ComputerBridge} from '../src/computer.js';
import {cloudModels} from '../src/models.js';
import {modelAccountRefusal} from '../src/routine-account-backoff.js';
import {serve} from '../src/server.js';
import {createClient,type TaskStatus} from '../src/client.js';
import {until} from '../test/helpers.js';

const {values:flags}=parseArgs({options:{live:{type:'boolean',default:false},headed:{type:'boolean',default:false},command:{type:'string'},'credential-stdin':{type:'boolean',default:false}}});
const limits={modelRequests:16,maxOutputTokens:768,elapsedMs:360000};
const workload=new AbortController();
const deadline=AbortSignal.any([workload.signal,AbortSignal.timeout(limits.elapsedMs)]);
const session='kada-handoff-'+randomUUID().slice(0,12);
const command=flags.command ?? process.env.AGENT_BROWSER_COMMAND ?? 'agent-browser';
const artifactRoot=resolve('.harness');await mkdir(artifactRoot,{recursive:true});
const directory=await mkdtemp(join(artifactRoot,'computer-browser-'));
const workspace=join(directory,'workspace');await mkdir(workspace);
let stage='setup',requests=0;
const verificationCode = 'KADA-FIXTURE-' + randomUUID();
const usage={inputTokens:0,outputTokens:0,cachedTokens:0,totalTokens:0,estimatedCostUsd:null};
const proof:Record<string,unknown>={};
const app={value:'',operatorChanged:false,updates:[] as string[]};
let page:Server|undefined,service:Awaited<ReturnType<typeof serve>>|undefined;
const bridge=new ComputerBridge(),operator=new Client({name:'kada-browser-operator-test',version:'1'});
const driver={command,args:['mcp'],env:{AGENT_BROWSER_SESSION:session},tools:['agent_browser_snapshot','agent_browser_fill','agent_browser_click'],observationTools:['agent_browser_snapshot'],leaseMs:120000};

function strings(value:unknown):string {
  if(typeof value==='string') {try {return strings(JSON.parse(value));}catch{return value;}}
  if(Array.isArray(value)) return value.map(strings).join('\n');
  if(value && typeof value==='object') return Object.values(value).map(strings).join('\n');
  return '';
}
function text(result:CallToolResult) {return result.content.filter(block=>block.type==='text').map(block=>strings(block.text)).join('\n');}
function ref(snapshot:string,role:'textbox'|'button',label:string) {
  const line=snapshot.split('\n').find(line=>line.includes(role+' "'+label+'"'));
  const id=line && /\bref=(@?e\d+)\b/.exec(line)?.[1];
  assert(id,'Expected control in the latest real browser snapshot: '+label);
  return id.startsWith('@') ? id : '@'+id;
}
async function browser(name:string,args:Record<string,unknown>={},signal:AbortSignal=deadline) {
  const result=await operator.callTool({name,arguments:{...args,session,allowedDomains:['127.0.0.1'],timeoutMs:20000}},undefined,{signal,timeout:30000}) as CallToolResult;
  assert(!result.isError,'Real browser operation failed: '+name);
  return result;
}
async function listen(server:Server) {await new Promise<void>((done,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',done);});return (server.address() as {port:number}).port;}
async function freePort() {const server=createServer();const port=await listen(server);await new Promise<void>(done=>server.close(()=>done()));return port;}

async function modelsForSmoke(names:{snapshot:string;fill:string;click:string}):Promise<{models:Models;ref:{provider:string;modelId:string}}> {
  if(!flags.live) {
    const provider=fauxProvider({provider:'computer-browser-fixture',models:[{id:'scripted'}]});
    const results=(context:TranscriptContext,name:string)=>context.messages.filter(message=>message.role==='toolResult'&&message.toolName===name);
    const call=(name:string,args:JsonObject={})=>fauxAssistantMessage(fauxToolCall(name,args),{stopReason:'toolUse'});
    provider.setResponses(Array.from({length:16},()=>async(context:TranscriptContext)=>{
      const returned = context.messages.some(message => message.role === 'user' && String(message.content).includes('The user finished the requested browser step'));
      if(results(context,'computer_begin').length<(returned ? 2 : 1)) return call('computer_begin');
      if(results(context,names.snapshot).length<(returned ? 2 : 1)) return call(names.snapshot,{interactive:!returned});
      if(!returned) return call('computer_request_sign_in', { step: 'verification' });
      const snapshot=strings(results(context,names.snapshot).at(-1)?.content);
      if(!results(context,names.fill).length) return call(names.fill,{selector:ref(snapshot,'textbox','Result'),text:'assistant-final'});
      if(results(context,names.snapshot).length<3) return call(names.snapshot,{interactive:true});
      if(!results(context,names.click).length) return call(names.click,{selector:ref(snapshot,'button','Apply result')});
      if(!results(context,'write').length) return call('write',{path:'result.json',content:JSON.stringify({value:app.value,operatorChanged:app.operatorChanged})});
      if(!results(context,'computer_end').length) return call('computer_end');
      return call('task_submit',{summary:'Browser result and local file verified.',artifacts:['result.json']});
    }));
    const models=createModels();models.setProvider(provider.provider);
    return {models,ref:{provider:'computer-browser-fixture',modelId:'scripted'}};
  }
  let apiKey=process.env.SILICONFLOW_API_KEY?.trim() ?? '';delete process.env.SILICONFLOW_API_KEY;
  if(!apiKey) {
    assert(process.stdin.isTTY || flags['credential-stdin'],'Set SILICONFLOW_API_KEY or use a terminal for the opt-in live test.');
    const raw=process.stdin.isRaw;if(process.stdin.isTTY) process.stdin.setRawMode(true);
    const input=createInterface({input:process.stdin,terminal:false});
    try {console.log('READY_FOR_CREDENTIAL');apiKey=(await new Promise<string>(done=>input.once('line',done))).trim();}
    finally {input.close();if(process.stdin.isTTY) process.stdin.setRawMode(raw===true);process.stdin.pause();}
  }
  assert(apiKey,'A SiliconFlow credential is required for --live.');
  const modelId=process.env.SILICONFLOW_MODEL ?? 'deepseek-ai/DeepSeek-V3.2';
  const model=cloudModels().getModel('siliconflow',modelId);assert(model && model.api==='openai-completions','Select an installed SiliconFlow model.');
  const native=openAICompletionsApi(),models=createModels();
  const options=(options:any)=>{
    assert(requests<limits.modelRequests,'Live model request limit reached.');requests++;
    return {...options,maxTokens:Math.min(options?.maxTokens ?? limits.maxOutputTokens,limits.maxOutputTokens),signal:AbortSignal.any([deadline,...(options?.signal ? [options.signal] : [])])};
  };
  const observe=(stream:ReturnType<typeof native.stream>)=>{void stream.result().then(message=>{
    usage.inputTokens+=message.usage.input;usage.outputTokens+=message.usage.output;usage.cachedTokens+=message.usage.cacheRead;usage.totalTokens+=message.usage.totalTokens;
    const refusal = modelAccountRefusal(message);
    if (refusal) proof.providerAccountRefusal = refusal;
  });return stream;};
  models.setProvider(createProvider({id:'siliconflow',models:[{...model,maxTokens:limits.maxOutputTokens}],baseUrl:model.baseUrl,
    auth:{apiKey:{name:'SiliconFlow local browser validation',resolve:async()=>({auth:{apiKey}})}},
    api:{stream:(model,context,input)=>observe(native.stream(model,context,options(input))),streamSimple:(model,context,input)=>observe(native.streamSimple(model,context,options(input)))}}));
  return {models,ref:{provider:'siliconflow',modelId}};
}

try {
  page=createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');
    if(req.url==='/state') {
      if(req.method==='POST') {
        let raw='';for await(const chunk of req) raw+=String(chunk);
        const input=JSON.parse(raw).value;
        const value = input === verificationCode && !app.operatorChanged ? 'operator-step' : input === 'assistant-final' && app.operatorChanged ? input : undefined;
        if(!value) {res.writeHead(400);res.end();return;}
        app.value=value;app.operatorChanged ||= value==='operator-step';app.updates.push(value);
      }
      res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(app));return;
    }
    if(req.url!=='/') {res.writeHead(404);res.end();return;}
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
    res.end(`<!doctype html><html lang="en"><title>Kada browser handoff verification</title><body>
      <h1>Local handoff fixture</h1>
      <section id="gate" ${app.operatorChanged ? 'hidden' : ''}>
        <label>Verification code<input id="code" aria-label="Verification code" autocomplete="off"></label>
        <button id="verify">Verify local sign-in</button>
      </section>
      <section id="work" ${app.operatorChanged ? '' : 'hidden'}>
        <label>Result<input id="result" aria-label="Result"></label><button id="apply">Apply result</button>
      </section>
      <p id="current" role="status">${app.value || 'Verification required'}</p>
      <script>
        async function send(value) {
          const reply = await fetch('/state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({value}) });
          if (!reply.ok) return;
          const state = await reply.json();
          document.querySelector('#code').value = '';
          document.querySelector('#gate').hidden = state.operatorChanged;
          document.querySelector('#work').hidden = !state.operatorChanged;
          document.querySelector('#current').textContent = state.value;
        }
        document.querySelector('#verify').onclick = () => send(document.querySelector('#code').value);
        document.querySelector('#apply').onclick = () => send(document.querySelector('#result').value);
      </script></body></html>`);
  });
  const pagePort=await listen(page),url=`http://127.0.0.1:${pagePort}/`;
  const {stdout:cliVersion}=await promisify(execFile)(command,['--version'],{encoding:'utf8',timeout:5000,windowsHide:true});
  proof.driverKind='installed agent-browser CLI';proof.cliVersion=cliVersion.trim();
  driver.args=['--import','tsx',fileURLToPath(new URL('./agent-browser-stdio.ts',import.meta.url)),command,url,session,join(directory,'handoff.png')];
  driver.command=process.execPath;
  const operatorTransport=new StdioClientTransport({command:driver.command,args:driver.args,env:driver.env,stderr:'pipe'});
  await operator.connect(operatorTransport);
  proof.driver=operator.getServerVersion();
  stage='open-local-page';await browser('agent_browser_open',{url,headed:flags.headed,webmcp:false});
  const extension=await bridge.connect(driver);
  const names=Object.fromEntries(['snapshot','fill','click'].map(kind=>[kind,extension.tools!.find(tool=>tool.name.endsWith('_agent_browser_'+kind))!.name])) as {snapshot:string;fill:string;click:string};
  const model=await modelsForSmoke(names);
  proof.model=model.ref;
  const policy=defineExtension({name:'local_browser_smoke_scope',hooks:[hook(ToolTask,{
    beforeTool(call) {
      if(!Object.values(names).includes(call.name)) return;
      const allowed=new Set(['interactive','selector','text','timeoutMs','session','allowedDomains']);
      if(Object.keys(call.arguments).some(key=>!allowed.has(key))) return {block:'Only the local smoke page controls are authorized.'};
      return {arguments:{...call.arguments,session,allowedDomains:['127.0.0.1'],timeoutMs:20000}};
    },
  })]});
  const config={dataDir:join(directory,'state'),port:await freePort(),model:model.ref,maxSubagents:1,maxDurationMs:240000,maxTotalTokens:120000,review:false,web:false,discovery:false};
  service=await serve(config,{models:model.models,extensions:[extension,policy],computer:bridge});
  const client=createClient(config);
  stage='agent-observes';
  const task=await client.request<{id:string}>('/v1/tasks','POST',{confirmed:true,workspace,objective:
    `In the already-open local test page, use computer_begin and ${names.snapshot} first. Call computer_request_sign_in with step verification and wait. The operator will complete the verification in the browser and return control. Then call computer_begin and ${names.snapshot} with interactive=false to read the status and current Result textbox ref. Use ${names.fill} on that textbox with text "assistant-final". Take a new snapshot, then use ${names.click} on Apply result. Keep the original page and session. Write result.json as {"value":"assistant-final","operatorChanged":true}. Release computer_end and submit result.json using task_submit.`,
    acceptance:[{type:'json_value',path:'result.json',pointer:'/value',equals:'assistant-final'},{type:'json_value',path:'result.json',pointer:'/operatorChanged',equals:true}],skills:[]});
  const status = () => client.request<TaskStatus>(`/v1/tasks/${task.id}`);
  const waiting = await until(status, state => state.status === 'waiting_user' && state.submission?.status === 'done'
    || ['completed', 'failed', 'blocked', 'budget_limited'].includes(state.status), 150_000);
  assert.equal(waiting.status, 'waiting_user');
  const question = waiting.userQuestion;
  assert.equal(question?.browserSignIn, 'verification');
  const signIn = (action: 'takeover' | 'continue') => client.request(`/v1/tasks/${task.id}/browser-sign-in/${question!.id}`, 'POST', { action });
  const owned=bridge.forTask(task.id),fill=owned.tools!.find(tool=>tool.name===names.fill)!;
  const attempt=()=>fill.execute({selector:'@e1',text:'blocked'},{ } as ToolExecutionApi,BACKGROUND_CONTEXT);
  stage='operator-takeover';
  await signIn('takeover');
  assert.equal(bridge.status().mode, 'user');
  await assert.rejects(attempt(),/control|takeover/i);assert.equal(app.updates.length,0);proof.agentActionsBlockedDuringTakeover=true;
  let snapshot=text(await browser('agent_browser_snapshot',{interactive:true}));
  await browser('agent_browser_fill',{selector:ref(snapshot,'textbox','Verification code'),text:verificationCode});
  snapshot=text(await browser('agent_browser_snapshot',{interactive:true}));
  await browser('agent_browser_click',{selector:ref(snapshot,'button','Verify local sign-in')});
  await until(async()=>app.value,value=>value==='operator-step');
  proof.operator='automated host-side operator using the selected real MCP driver';
  // The verification kills only the bridge-owned SDK child, never a PID inferred from a process name.
  const bridgeTransport=(Reflect.get(bridge,'client') as Client).transport as StdioClientTransport;
  const interruptedPid=bridgeTransport.pid;
  assert(interruptedPid && interruptedPid!==operatorTransport.pid,'Need the distinct bridge-owned driver process.');
  process.kill(interruptedPid,'SIGKILL');
  await until(async()=>bridge.status().connected,connected=>!connected);
  assert.equal(bridge.status().owner,null);
  await bridge.connect(driver);
  assert.equal(bridge.status().observed,false);
  proof.driverTransportForcedInterruption=true;
  proof.sameTaskAfterDriverReconnect=true;
  assert.equal(bridge.status().mode, 'user');
  await assert.rejects(attempt(),/control/i);
  stage='agent-reobserves';
  await signIn('continue');
  const done=await until(status,state=>['completed','failed','needs_attention','budget_limited','blocked'].includes(state.status),240000);
  assert.equal(done.status,'completed','Task did not deliver a verified result.');
  assert.deepEqual(app.updates,['operator-step','assistant-final']);
  const backend=await (await fetch(url+'state',{signal:deadline})).json();assert.equal(backend.value,'assistant-final');assert.equal(backend.operatorChanged,true);
  const file=JSON.parse(await readFile(join(workspace,'result.json'),'utf8'));assert.deepEqual(file,{value:backend.value,operatorChanged:backend.operatorChanged});
  const tools=done.messages.filter(message=>message.role==='toolResult');
  const snapshots=tools.filter(message=>message.role==='toolResult'&&message.toolName===names.snapshot&&!message.isError);assert(snapshots.length>=3);
  assert(snapshots.some(message=>JSON.stringify(message.content).includes('operator-step')));
  assert(!JSON.stringify(done.messages).includes(verificationCode));
  assert.equal(done.messages.filter(message => message.role === 'user' && String(message.content).includes('The user finished the requested browser step')).length, 1);
  proof.browserVerificationCodeKeptOutOfTranscript = true;
  proof.originalSignInRequestResumed = true;
  assert.equal(tools.filter(message=>message.role==='toolResult'&&message.toolName===names.fill&&!message.isError).length,1);
  assert.equal(tools.filter(message=>message.role==='toolResult'&&message.toolName===names.click&&!message.isError).length,1);
  stage='independent-verification';proof.pageAndFileMatch=true;proof.applicationUpdates=app.updates;proof.taskId=task.id;proof.successfulSnapshots=snapshots.length;proof.freshObservationSawOperatorChange=true;proof.taskTokens=done.budget.totalTokens;
  snapshot=text(await browser('agent_browser_snapshot',{interactive:false}));assert(snapshot.includes('assistant-final'));
  await browser('agent_browser_screenshot',{path:join(directory,'handoff.png')});
  proof.finalSnapshotIncludesVerifiedResult=true;proof.completed=true;
  console.log(JSON.stringify({passed:true,mode:flags.live ? 'siliconflow' : 'scripted-model',modelRequests:requests,taskTokens:done.budget.totalTokens}));
} catch(error) {
  process.exitCode=1;proof.completed=false;
  proof.failure=proof.providerAccountRefusal ? 'provider_account_refusal' : error instanceof assert.AssertionError ? 'independent_assertion_failed' : 'operation_failed';
  if(!flags.live && error instanceof Error) proof.fixtureDiagnostic=error.message.slice(0,1500);
  console.error(JSON.stringify({passed:false,stage,failure:proof.failure,...(!flags.live ? {diagnostic:proof.fixtureDiagnostic} : {})}));
} finally {
  workload.abort();
  await service?.close();await bridge.close();
  try {await browser('agent_browser_close',{},AbortSignal.timeout(15000));proof.browserClosedWithWorkloadAborted=true;}
  catch {proof.browserClosedWithWorkloadAborted=false;proof.completed=false;process.exitCode=1;}
  await operator.close();
  if(page) {page.closeAllConnections();await new Promise<void>(done=>page!.close(()=>done()));}
  const report={at:new Date().toISOString(),mode:flags.live ? 'siliconflow' : 'scripted-model',realDriver:true,localPageOnly:true,fixture:directory.slice(artifactRoot.length+1),limits,modelRequests:requests,usage,stage,proof};
  const resultPath = join(directory, 'result.json');
  await writeFile(resultPath, JSON.stringify(report, null, 2) + '\n');
  console.log('Evidence: ' + resultPath);
}
