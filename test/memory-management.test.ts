import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createModels, fauxAssistantMessage, fauxProvider,fauxToolCall } from "@earendil-works/pi-ai";
import { LocalRuntime } from "../src/runtime.js";
import { until } from "./helpers.js";
import { LocalDiscovery } from "../src/discovery.js";
import { createClient } from "../src/client.js";
import { serve } from "../src/server.js";

async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "kada-memory-management-")));
  const home = join(directory, "home"), data = join(directory, "state");
  const alpha = join(directory, "alpha"), beta = join(directory, "beta");
  await Promise.all([home, join(alpha, ".git"), join(beta, ".git")].map(path => mkdir(path, { recursive: true })));
  await writeFile(join(alpha, "AGENTS.md"), "项目日报请用中文。");
  await writeFile(join(beta, "AGENTS.md"), "项目日报请用法文。");
  const discovery = new LocalDiscovery(data, { home, timezone: "America/Los_Angeles" });
  return { directory, home, data, alpha, beta, discovery, close: () => rm(directory, { recursive: true, force: true }) };
}

test("M01/M02 project memory views filter scope and keep stable source revisions", async () => {
  const f = await fixture();
  try {
    const first = await f.discovery.memoryView(f.alpha);
    const fact = first.facts.find(item => item.text === "项目日报请用中文。");
    assert(fact);
    assert.equal(fact.scope, "project");
    assert.match(fact.revision, /^[a-f0-9]{64}$/);
    assert.equal(fact.evidence[0]?.path, join(f.alpha, "AGENTS.md"));
    assert.match(fact.evidence[0]?.sha256 ?? "", /^[a-f0-9]{64}$/);
    const beta = await f.discovery.memoryView(f.beta);
    assert(beta.facts.some(item => item.text === "项目日报请用法文。"));
    assert(!beta.facts.some(item => item.text === "项目日报请用中文。"));
    const again = await f.discovery.memoryView(f.alpha);
    assert.equal(again.facts.find(item => item.id === fact.id)?.revision, fact.revision);
    assert(!again.facts.some(item => item.text === "项目日报请用法文。"));
  } finally { await f.close(); }
});

test("M03/M04 concurrent corrections conflict and persisted request identities return the original result", async () => {
  const f = await fixture();
  try {
    const original = (await f.discovery.memoryView(f.alpha)).facts.find(item => item.text === "项目日报请用中文。")!;
    assert(original);
    const choices = ["项目日报请用英文。", "项目日报请用德文。"].map((text, index) => ({
      action: "correct" as const, text, expectedRevision: original.revision, requestId: "edit-" + index,
    }));
    const results = await Promise.allSettled(choices.map(input => f.discovery.memory.change(f.home, original.id, input, f.alpha)));
    const winner = results.findIndex(result => result.status === "fulfilled");
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    const failure = results.find(result => result.status === "rejected");
    assert(failure?.status === "rejected");
    assert.equal(failure.reason.status, 409);
    const saved = results[winner];
    assert(saved?.status === "fulfilled");
    const reopened = new LocalDiscovery(f.data, { home: f.home });
    const replay = await reopened.memory.change(f.home, original.id, choices[winner]!, f.alpha);
    assert.deepEqual(replay, saved.value);
    const facts = (await reopened.memoryView(f.alpha)).facts;
    assert(facts.some(item => item.id === replay.id && item.text === choices[winner]!.text));
    assert(!facts.some(item => item.id === original.id));
    await assert.rejects(reopened.memory.change(f.home, original.id, { ...choices[winner]!, text: "同一标识的不同请求。" }, f.alpha), (error: { status?: number }) => error.status === 409);
    assert.equal(await readFile(join(f.alpha, "AGENTS.md"), "utf8"), "项目日报请用中文。");
  } finally { await f.close(); }
});

test('M02/M08 duplicate source facts keep each stored revision in the supplied reference list', async () => {
  const f = await fixture();
  try {
    await f.discovery.memoryView(f.alpha);
    const value = await f.discovery.memory.read(f.home);
    const first = value.facts.find(fact => fact.text === '项目日报请用中文。')!;
    value.facts.push({...structuredClone(first),id:'duplicate-source',evidence:[{...first.evidence[0]!,sourceId:'another-source',path:join(f.alpha,'CLAUDE.md')}]});
    const visible = f.discovery.memory.list(value);
    const context = f.discovery.memory.context(value,'日报',first.project);
    const refs = context.references!.filter(reference => reference.text === first.text);
    assert.equal(refs.length,2);
    for (const reference of refs) assert.equal(reference.revision,visible.find(fact => fact.id === reference.factId)!.revision);
  } finally { await f.close(); }
});

test("M05/M06 forgotten project facts stay forgotten after scans and other projects retain their own facts", async () => {
  const f = await fixture();
  try {
    const original = (await f.discovery.memoryView(f.alpha)).facts.find(item => item.text === "项目日报请用中文。")!;
    const input = { action: "forget" as const, expectedRevision: original.revision, requestId: "forget-one" };
    const result = await f.discovery.memory.change(f.home, original.id, input, f.alpha);
    assert.equal(result.state, "forgotten");
    await writeFile(join(f.alpha, "AGENTS.md"), "项目日报请用中文。\n\n交付需要注明输入文件。");
    const reopened = new LocalDiscovery(f.data, { home: f.home });
    await reopened.load(true);
    const view = await reopened.memoryView(f.alpha);
    assert(!view.facts.some(item => item.text === "项目日报请用中文。"));
    assert(view.facts.some(item => item.text.includes("注明输入文件")));
    assert.deepEqual(await reopened.memory.change(f.home, original.id, input, f.alpha), result);
    const beta = await reopened.memoryView(f.beta);
    assert(beta.facts.some(item => item.text === "项目日报请用法文。"));
    await assert.rejects(reopened.memory.change(f.home, original.id, { ...input, requestId: "wrong-scope" }, f.beta), (error: { status?: number }) => error.status === 404);
  } finally { await f.close(); }
});

test("memory HTTP and terminal-facing endpoints provide authenticated revisions, corrections and forget", async () => {
  const f = await fixture();
  const socket = createServer();
  await new Promise<void>(done => socket.listen(0, "127.0.0.1", done));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>(done => socket.close(() => done()));
  const config = { dataDir: f.data, port, maxSubagents: 1, maxDurationMs: 30000, discovery: true, web: false };
  const server = await serve(config, { models: createModels(), discovery: { home: f.home } });
  const client = createClient(config);
  const query = "?workspace=" + encodeURIComponent(f.alpha);
  try {
    const view = await client.request<Awaited<ReturnType<LocalDiscovery["memoryView"]>>>("/v1/environment/memory" + query);
    const fact = view.facts.find(item => item.text === "项目日报请用中文。")!;
    assert(fact);
    const result = await client.request<{ id: string; revision: string }>("/v1/environment/memory/" + fact.id + query, "PATCH", {
      text: "项目日报请用英文。", expectedRevision: fact.revision, requestId: "http-edit",
    });
    assert.notEqual(result.id, fact.id);
    await client.request("/v1/environment/memory/" + result.id + "/forget" + query, "POST", {
      expectedRevision: result.revision, requestId: "http-forget",
    });
    const after = await client.request<Awaited<ReturnType<LocalDiscovery["memoryView"]>>>("/v1/environment/memory" + query);
    assert(!after.facts.some(item => item.id === result.id));
  } finally { await server.close(); await f.close(); }
});


test("M04 a killed memory writer retains its correction and original request receipt", { timeout: 60000 }, async () => {
  const f = await fixture();
  let child: ChildProcess | undefined;
  try {
    const fact = (await f.discovery.memoryView(f.alpha)).facts.find(item => item.text === "项目日报请用中文。")!;
    const input = { action: "correct" as const, text: "项目日报请用英文。", expectedRevision: fact.revision, requestId: "crash-edit" };
    const inputPath = join(f.directory, "operation.json");
    await writeFile(inputPath, JSON.stringify({ data: f.data, home: f.home, workspace: f.alpha, id: fact.id, input }));
    child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./fixtures/memory-edit-worker.ts", import.meta.url)), inputPath], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "", stderr = "";
    child.stdout!.on("data", data => { stdout += String(data); });
    child.stderr!.on("data", data => { stderr += String(data); });
    const exited = new Promise<void>((done, reject) => { child!.once("error", reject); child!.once("exit", () => done()); });
    await until(async () => {
      assert.equal(child!.exitCode ?? child!.signalCode, null, stderr);
      return stdout;
    }, text => text.includes('"type":"saved"'), 30000);
    const committed = JSON.parse(stdout.trim().split("\n").at(-1)!).result;
    assert.equal(child.kill("SIGKILL"), true);
    await exited;
    const reopened = new LocalDiscovery(f.data, { home: f.home });
    const replay = await reopened.memory.change(f.home, fact.id, input, f.alpha);
    assert.deepEqual(replay, committed);
    assert((await reopened.memoryView(f.alpha)).facts.some(item => item.id === committed.id && item.text === input.text));
    assert.equal(await readFile(join(f.alpha, "AGENTS.md"), "utf8"), "项目日报请用中文。");
  } finally { if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await f.close(); }
});
test("M07/M08 ordinary chats retain versioned memory-use records without creating a Goal", async () => {
  const f = await fixture();
  const provider = fauxProvider({ provider: "memory-management", models: [{ id: "scripted" }] });
  let calls = 0;
  provider.setResponses(Array.from({ length: 16 }, () => context => {
    calls++;
    return fauxAssistantMessage(JSON.stringify(context.messages).includes("项目日报请用英文") ? "采用英文日报设置。" : "采用中文日报设置。");
  }));
  const models = createModels(); models.setProvider(provider.provider);
  const config = { dataDir: f.data, port: 4317, model: { provider: "memory-management", modelId: "scripted" }, maxSubagents: 1, maxDurationMs: 30000, discovery: true, web: false, review: false };
  let runtime = new LocalRuntime(config, { models, discovery: { home: f.home } });
  try {
    const task = await runtime.create("确认项目日报的偏好。", f.alpha, [], { chat: true });
    await until(() => runtime.status(task.id), value => value.status === "answered");
    assert.equal((await runtime.status(task.id)).goal, undefined);
    const initial = await runtime.taskMemory(task.id);
    const original = initial.references.find(reference => reference.text === "项目日报请用中文。");
    assert(original);
    assert(initial.current.includes(original.factId + "@" + original.revision));
    const beforeRestart = calls;
    await runtime.close();
    runtime = new LocalRuntime(config, { models, discovery: { home: f.home } });
    await runtime.recover();
    assert.equal(calls, beforeRestart);
    assert.deepEqual(await runtime.taskMemory(task.id), initial);
    const corrected = await runtime.changeMemory(original.factId, {
      action: "correct", text: "项目日报请用英文。", expectedRevision: original.revision, requestId: "task-memory-edit",
    }, f.alpha);
    const after = await runtime.taskMemory(task.id);
    assert(after.references.some(reference => reference.factId === original.factId && reference.revision === original.revision));
    assert(!after.references.some(reference => reference.factId === corrected.id),'an idle completed chat has not received the new memory');
    assert.deepEqual(after,initial);
    await runtime.followUp(task.id,'再次确认日报偏好。','after-correction');
    await until(()=>runtime.status(task.id),status=>status.status==='answered' && status.submission?.requestId==='user:after-correction');
    const used=await runtime.taskMemory(task.id);
    assert(used.current.includes(corrected.id+'@'+corrected.revision));
    assert(used.references.some(reference=>reference.factId===original.factId));
    const next = await runtime.create("再次确认项目日报偏好。", f.alpha, [], { chat: true });
    const reply = await until(() => runtime.status(next.id), value => value.status === "answered");
    assert.equal(reply.goal, undefined);
    assert(reply.messages.some(message => message.role === "assistant" && message.content.some(part => part.type === "text" && part.text.includes("英文"))));
  } finally { await runtime.close(); await f.close(); }
});

test('M07 memory searched through a real Pi tool is recorded when supplied',async()=>{
  const f=await fixture();
  let runtime:LocalRuntime|undefined;
  try {
    await writeFile(join(f.alpha,'AGENTS.md'),'项目日报请用中文。\n\n项目内部标记为 LOOKUP_421。');
    const fact=(await f.discovery.memoryView(f.alpha)).facts.find(fact=>fact.text.includes('LOOKUP_421'))!;
    assert(fact);
    const provider=fauxProvider({provider:'memory-search',models:[{id:'scripted'}]});
    provider.setResponses([
      fauxAssistantMessage(fauxToolCall('user_memory_search',{query:'LOOKUP_421',domain:fact.domain ?? 'unknown'}),{stopReason:'toolUse'}),
      fauxAssistantMessage('已查到项目标记。'),
    ]);
    const models=createModels();models.setProvider(provider.provider);
    runtime=new LocalRuntime({dataDir:f.data,port:4317,model:{provider:'memory-search',modelId:'scripted'},maxSubagents:1,maxDurationMs:30000,discovery:true,web:false},{models,discovery:{home:f.home}});
    const task=await runtime.create('你好，只做普通聊天。',f.alpha,[],{chat:true});
    const done=await until(()=>runtime!.status(task.id),status=>status.status==='answered');
    const result=done.messages.find(message=>message.role==='toolResult'&&message.toolName==='user_memory_search');
    assert(result && JSON.stringify(result).includes('LOOKUP_421'));
    assert((await runtime.taskMemory(task.id)).references.some(reference=>reference.factId===fact.id));
    assert.equal(done.goal,undefined);
  } finally {await runtime?.close();await f.close();}
});

test('M07 producing a search result alone does not claim the model used it',async()=>{
  const f=await fixture();
  try {
    const fact=(await f.discovery.memoryView(f.alpha)).facts.find(fact=>fact.text.includes('中文'))!;
    const state={initialized:false,current:[] as string[],references:[] as unknown[],summary:'',updatedAt:0};
    const api={conversationId:'search-only',commit:async(fn:any)=>fn({doc:async()=>state})};
    const extension=f.discovery.memory.extension('search-only',f.home,()=>f.discovery.load(),undefined,f.alpha,true);
    const search=extension.tools!.find(tool=>tool.name==='user_memory_search')!;
    await (search.execute as any)({query:'日报',domain:fact.domain},api,{});
    assert.deepEqual(state.references,[]);
  } finally {await f.close();}
});
