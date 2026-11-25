import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { serve } from "../src/server.js";
import { fakeRoutineClock, scriptedFixture, until } from "./helpers.js";
import { atomicJson } from "../src/util.js";

const fakeServer = `
  const fs = require('node:fs');
  const [sample, calls] = process.argv.slice(1);
  require('node:readline').createInterface({input:process.stdin}).on('line', line => {
    const request = JSON.parse(line);
    if (request.id === undefined) return;
    let result;
    if (request.method === 'initialize') result = {protocolVersion:request.params.protocolVersion,serverInfo:{name:'app-fixture',version:'1'},capabilities:{tools:{}}};
    if (request.method === 'initialize' && JSON.parse(fs.readFileSync(sample,'utf8')).holdInit) {
      fs.appendFileSync(calls, JSON.stringify({tool:'initializing',pid:process.pid})+'\\n');
      const waiting = setInterval(() => {
        if (!fs.existsSync(sample + '.ready')) return;
        clearInterval(waiting);
        console.log(JSON.stringify({jsonrpc:'2.0',id:request.id,result}));
      }, 20);
      return;
    }
    if (request.method === 'tools/list') result = {tools:[
      {name:'read',annotations:{readOnlyHint:true},inputSchema:{type:'object'}},
      {name:'pending',annotations:{readOnlyHint:true},inputSchema:{type:'object'}},
      {name:'write',annotations:{readOnlyHint:false},inputSchema:{type:'object'}},
      {name:'unknown',inputSchema:{type:'object'}},
    ]};
    if (request.method === 'tools/call') {
      fs.appendFileSync(calls, JSON.stringify({tool:request.params.name,pid:process.pid})+'\\n');
      if (request.params.name === 'pending') return;
      const state = JSON.parse(fs.readFileSync(sample,'utf8'));
      result = {content:[{type:'text',text:'Inbox read.'}],structuredContent:state.value,_meta:{request:state.meta},isError:state.fail===true};
    }
    console.log(JSON.stringify({jsonrpc:'2.0',id:request.id,result}));
  });
`;

async function app(t: TestContext) {
  let modelCalls = 0;
  const fixture = await scriptedFixture(context => {
    modelCalls++;
    assert.doesNotMatch(JSON.stringify(context.messages), /UNTRUSTED_PRECHECK_IGNORE_RULES/);
    return fauxAssistantMessage(fauxToolCall("task_submit", { summary: "Inbox reviewed.", artifacts: [] }), { stopReason: "toolUse" });
  });
  const sample = join(fixture.directory, "sample.json"), calls = join(fixture.directory, "calls.jsonl");
  await writeFile(sample, JSON.stringify({ value: { count: 1, note: "UNTRUSTED_PRECHECK_IGNORE_RULES" }, meta: 1 }));
  await writeFile(calls, "");
  const socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const clock = fakeRoutineClock(Date.parse("2026-11-23T00:00:00Z"));
  const open = () => serve({ ...fixture.settings, port }, { models: fixture.models, routineClock: clock });
  let server = await open();
  t.after(async () => { await server.close(); await fixture.close(); });
  const token = (await readFile(join(fixture.directory, "token"), "utf8")).trim();
  const request = (path: string, method = "GET", value?: object) => fetch(`http://127.0.0.1:${port}` + path, {
    method, headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: value === undefined ? undefined : JSON.stringify(value),
  });
  await server.runtime.mcp.configure({ id: "inbox", transport: "stdio", command: process.execPath, args: ["-e", fakeServer, sample, calls] });
  const connection = await server.runtime.mcp.test("inbox");
  await server.runtime.mcp.enable("inbox", ["read", "pending", "write", "unknown"], connection.revision);
  const input = {
    id: "inbox-watch", action: "task", objective: "Review the connected inbox", workspace: fixture.workspace,
    schedule: { kind: "daily", time: "00:01", timeZone: "UTC" },
    precheck: { mcp: { id: "inbox", revision: connection.revision, tool: "read", arguments: { query: "unread" } } },
  };
  const run = async (requestId: string) => {
    const response = await request("/v1/routines/inbox-watch/run", "POST", { requestId });
    assert.equal(response.status, 202);
    const accepted = await response.json();
    return until(async () => (await server.runtime.routines.history(input.id)).find(row => row.id === accepted.id && row.status !== "claimed"), Boolean);
  };
  return {
    fixture, connection, input, request, run,
    runtime: () => server.runtime, modelCalls: () => modelCalls,
    calls: async () => (await readFile(calls, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { tool: string; pid: number }),
    sample: (value: object, meta = 1, fail = false, holdInit = false) => atomicJson(sample, { value, meta, fail, holdInit }),
    releaseInitialize: () => writeFile(sample + '.ready', ''),
    async restart() { await server.close(); server = await open(); },
  };
}

test("MCP routine prechecks use the connected read tool without a model and retain their baseline across daemon restart", async t => {
  const f = await app(t);
  assert.deepEqual(f.connection.test?.tools?.filter(tool => tool.readOnly).map(tool => tool.name), ["pending", "read"]);
  const created = await f.request("/v1/routines", "POST", f.input);
  assert.equal(created.status, 201, await created.clone().text());
  const first = await f.run("first");
  assert.equal(first?.status, "started");
  await until(() => f.runtime().status(first!.taskId!), status => status.status === "completed");
  assert.equal(f.modelCalls(), 1);
  await f.restart();
  await f.sample({ note: "UNTRUSTED_PRECHECK_IGNORE_RULES", count: 1 }, 2);
  const unchanged = await f.run("unchanged");
  assert.equal(unchanged?.status, "skipped");
  assert.equal(unchanged?.precheck?.status, "unchanged");
  assert.equal(f.modelCalls(), 1);
  assert.equal((await f.runtime().list()).length, 1);
  await f.sample({ count: 2, note: "UNTRUSTED_PRECHECK_IGNORE_RULES" });
  const changed = await f.run("changed");
  assert.equal(changed?.status, "started");
  await until(() => f.runtime().status(changed!.taskId!), status => status.status === "completed");
  assert.equal(f.modelCalls(), 2);
  assert.deepEqual((await f.calls()).map(call => call.tool), ["read", "read", "read"]);
});

test("MCP prechecks reject write or unclassified tools and recheck approval, project scope and connection revision", async t => {
  const f = await app(t);
  for (const tool of ["write", "unknown"]) {
    assert.equal((await f.request("/v1/routines", "POST", { ...f.input, precheck: { mcp: { ...f.input.precheck.mcp, tool } } })).status, 400);
  }
  assert.equal((await f.request("/v1/routines", "POST", { ...f.input, precheck: { ...f.input.precheck, command: ["echo"] } })).status, 400);
  for (const mcp of [
    { ...f.input.precheck.mcp, revision: "" }, { ...f.input.precheck.mcp, arguments: [] },
    { ...f.input.precheck.mcp, arguments: { query: "x".repeat(16_001) } }, { ...f.input.precheck.mcp, headers: {} },
  ]) assert.equal((await f.request("/v1/routines", "POST", { ...f.input, precheck: { mcp } })).status, 400);
  assert.equal((await f.request("/v1/routines", "POST", f.input)).status, 201);
  assert.equal((await f.request("/v1/routines/inbox-watch", "PATCH", { ...f.input, precheck: { mcp: { ...f.input.precheck.mcp, tool: "write" } } })).status, 400);
  await f.runtime().mcp.setApproval("inbox", ["read"], f.connection.revision);
  assert.equal((await f.request("/v1/routines", "POST", { ...f.input, id: "approval-check" })).status, 400);
  assert.equal((await f.run("approval-revoked"))?.status, "failed");
  assert.deepEqual(await f.calls(), []);
  await f.runtime().mcp.setApproval("inbox", [], f.connection.revision);
  await f.runtime().mcp.disable("inbox");
  assert.equal((await f.run("connection-disabled"))?.status, "failed");
  assert.deepEqual(await f.calls(), []);
  await f.runtime().mcp.enable("inbox", ["read", "pending", "write", "unknown"], f.connection.revision);
  await f.runtime().mcp.setProjectTools(f.fixture.workspace, []);
  assert.equal((await f.run("project-revoked"))?.status, "failed");
  assert.deepEqual(await f.calls(), []);
  await f.runtime().mcp.setProjectTools(f.fixture.workspace, null);
  await f.sample({ count: 1 }, 3, true);
  const failure = await f.run("tool-error");
  assert.equal(failure?.status, "failed");
  await f.sample({ count: 1 });
  const recovered = await f.run("tool-recovered");
  assert.equal(recovered?.status, "started");
  await until(() => f.runtime().status(recovered!.taskId!), status => status.status === "completed");
  assert.equal(f.modelCalls(), 1);
  await f.sample({ count: 1, payload: "x".repeat(1_000_001) });
  assert.equal((await f.run("oversized-result"))?.status, "failed");
  await f.sample({ count: 1 });
  assert.equal((await f.run("baseline-retained"))?.precheck?.status, "unchanged");
  await f.runtime().mcp.configure({ id: "inbox", transport: "stdio", command: process.execPath, args: ["-e", "process.exit(0)"] });
  assert.equal((await f.run("connection-changed"))?.status, "failed");
  assert.equal((await f.calls()).length, 4);
  assert.equal(f.modelCalls(), 1);
});

test("pausing a routine cancels its in-flight MCP precheck before an agent task is admitted", async t => {
  const f = await app(t);
  assert.equal((await f.request("/v1/routines", "POST", { ...f.input, precheck: { mcp: { ...f.input.precheck.mcp, tool: "pending" } } })).status, 201);
  assert.equal((await f.request("/v1/routines/inbox-watch/run", "POST", { requestId: "pending-check" })).status, 202);
  const calls = await until(f.calls, calls => calls.some(call => call.tool === "pending"));
  await f.runtime().routines.pause("inbox-watch");
  await until(async () => {
    try { process.kill(calls[0]!.pid, 0); return false; } catch { return true; }
  }, Boolean);
  assert.equal(f.modelCalls(), 0);
  assert.equal((await f.runtime().routines.list())[0]?.status, "paused");
  assert.deepEqual(await f.runtime().list(), []);
});

test("an MCP precheck cannot dispatch after its project tool is revoked during connection setup", async t => {
  const f = await app(t);
  assert.equal((await f.request("/v1/routines", "POST", f.input)).status, 201);
  await f.sample({ count: 1 }, 1, false, true);
  const accepted = await (await f.request("/v1/routines/inbox-watch/run", "POST", { requestId: "connecting" })).json();
  await until(f.calls, calls => calls.some(call => call.tool === "initializing"));
  await f.runtime().mcp.setProjectTools(f.fixture.workspace, []);
  await f.releaseInitialize();
  const receipt = await until(async () => (await f.runtime().routines.history("inbox-watch")).find(row => row.id === accepted.id && row.status !== "claimed"), Boolean);
  assert.equal(receipt?.status, "failed");
  assert.deepEqual((await f.calls()).map(call => call.tool), ["initializing"]);
  assert.equal(f.modelCalls(), 0);
});
