import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { Script } from "node:vm";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall, getCurrentTools, Type } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTool, Harness, UserEntry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { memoryProject } from "../src/memory-sources.js";
import { createRemoteCredential, createRemoteHandler, quarantineLegacyRemoteTasks, type RemoteDevice } from "../src/remote.js";
import { LocalRuntime } from "../src/runtime.js";
import { hasTool, scriptedFixture, until } from "./helpers.js";

const sha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const turn = (messageId: string, text: string, attachmentIds: string[] = []) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ messageId, text, attachmentIds }),
});

async function portal(t: TestContext, runtime: LocalRuntime, directory: string, devices: readonly RemoteDevice[]) {
  let handle: ReturnType<typeof createRemoteHandler>;
  const server = createServer((request, response) => {
    void handle(request, response).then((handled) => {
      if (!handled) response.writeHead(404).end();
    }).catch(() => response.destroy());
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  let closing: Promise<void> | undefined;
  const close = () => closing ??= new Promise<void>((done) => server.close(() => done()));
  t.after(close);
  const address = server.address();
  assert(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  handle = createRemoteHandler(runtime, { directory, origin, devices });
  const call = (token: string, path: string, init?: RequestInit) => fetch(origin + "/remote/api" + path, {
    ...init, headers: { Authorization: `Bearer ${token}`, ...init?.headers },
  });
  return { origin, close, call };
}

function pairing(accountId = "owner", deviceId = "phone") {
  const { token, tokenHash } = createRemoteCredential();
  return { token, device: { accountId, deviceId, tokenHash } };
}

test("D01 concurrent duplicates and a lost HTTP response keep the original task and request", async (t) => {
  const fixture = await scriptedFixture(() => fauxAssistantMessage("Received."));
  t.after(() => fixture.close());
  const owner = pairing();
  const { call, origin } = await portal(t, fixture.runtime, join(fixture.directory, "remote"), [owner.device]);
  const requestPath = "/conversations/errand/messages";
  const receiptPath = "/conversations/errand?messageId=first";
  await new Promise<void>((resolve, reject) => {
    const request = httpRequest(origin + "/remote/api" + requestPath, {
      method: "POST",
      headers: { Authorization: `Bearer ${owner.token}`, "Content-Type": "application/json" },
    });
    request.once("error", reject);
    request.once("response", (response) => {
      response.destroy();
      resolve();
    });
    request.end(JSON.stringify({ messageId: "first", text: "Hello." }));
  });
  const saved = await (await call(owner.token, receiptPath)).json();
  assert.equal(saved.state, "submitted");
  const repeated = await Promise.all([1, 2].map(() => call(owner.token, requestPath, turn("first", "Hello."))));
  assert(repeated.every((response) => response.status === 200));
  const [one, two] = await Promise.all(repeated.map((response) => response.json()));
  assert.deepEqual(one, saved);
  assert.deepEqual(two, saved);
  assert.equal(one.state, "submitted");
  assert.equal(one.conversationId, "errand");
  assert.equal(one.messageId, "first");
  assert.equal((await call(owner.token, requestPath, turn("first", "Different."))).status, 409);
  assert.deepEqual(await (await call(owner.token, receiptPath)).json(), one);
  assert.equal((await fixture.runtime.list()).length, 1);
  await until(() => fixture.runtime.status(one.taskId), (value) => value.messages.some((m) => m.role === "assistant"));
  const view = await (await call(owner.token, "/conversations/errand")).json();
  assert.equal(view.messages.filter((m: { role: string }) => m.role === "user").length, 1);
  const racing = await Promise.all([1, 2].map(() =>
    call(owner.token, "/conversations/race/messages", turn("another", "Just once."))));
  assert.deepEqual(racing.map((response) => response.status).sort(), [200, 202]);
  assert.deepEqual(await racing[0]!.json(), await racing[1]!.json());
  assert.equal((await fixture.runtime.list()).length, 2);
});

test("D02 the portal rejects unpaired devices, foreign origins, and conversation access by other devices", async (t) => {
  const fixture = await scriptedFixture(() => fauxAssistantMessage("Received."));
  t.after(() => fixture.close());
  await mkdir(join(fixture.directory, ".git"));
  const owner = pairing();
  const otherPhone = pairing("owner", "tablet");
  const stranger = pairing("stranger", "phone");
  const { call, origin } = await portal(t, fixture.runtime, join(fixture.directory, "remote"), [owner.device, otherPhone.device, stranger.device]);
  const page = await fetch(origin + "/remote");
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Kada/);
  assert(!html.includes(owner.token));
  const script = await (await fetch(origin + "/remote/app.js")).text();
  assert.doesNotThrow(() => new Script(script));
  assert(!script.includes(owner.token));
  const path = origin + "/remote/api/session";
  assert.equal((await fetch(path)).status, 401);
  assert.equal((await fetch(path, { headers: { Authorization: "Bearer unpaired" } })).status, 401);
  const authorization = { Authorization: `Bearer ${owner.token}` };
  assert.equal((await fetch(path, { headers: { ...authorization, Origin: "https://elsewhere.example" } })).status, 403);
  assert.deepEqual(await (await fetch(path, { headers: authorization })).json(), {
    channel: "web",
    accountId: "owner",
    deviceId: "phone",
  });
  const endpoint = "/conversations/private";
  const privateRequest = await call(owner.token, endpoint + "/messages", turn("one", "A private request."));
  assert.equal(privateRequest.status, 202);
  const first = await privateRequest.json();
  for (const device of [otherPhone, stranger]) {
    assert.equal((await call(device.token, endpoint)).status, 404);
    assert.deepEqual(await (await call(device.token, "/conversations")).json(), []);
  }
  assert.equal((await call(otherPhone.token, endpoint + "/messages", turn("one", "A different body."))).status, 404);
  const response = await call(stranger.token, endpoint + "?messageId=one");
  assert.equal((await response.json()).state, "unknown");
  const second = await (await call(stranger.token, endpoint + "/messages", turn("one", "Another private request."))).json();
  const firstWorkspace = (await fixture.runtime.status(first.taskId)).workspace;
  const secondWorkspace = (await fixture.runtime.status(second.taskId)).workspace;
  assert.notEqual(firstWorkspace, secondWorkspace);
  assert.equal(await memoryProject(firstWorkspace), firstWorkspace);
  assert.equal(await memoryProject(secondWorkspace), secondWorkspace);
  assert.equal((await fetch(origin + "/v1/tasks", { headers: authorization })).status, 404);
});

test("D03 restart reconciles saved task and follow-up IDs, while missing admission remains interrupted", async (t) => {
  const fixture = await scriptedFixture(() => fauxAssistantMessage("Saved reply."));
  let restarted: LocalRuntime | undefined;
  let closeBefore: (() => Promise<void>) | undefined;
  let closeAfter: (() => Promise<void>) | undefined;
  t.after(async () => {
    await closeBefore?.();
    await closeAfter?.();
    await restarted?.close();
    await fixture.close();
  });
  const owner = pairing();
  const directory = join(fixture.directory, "remote");
  const before = await portal(t, fixture.runtime, directory, [owner.device]);
  closeBefore = before.close;
  const endpoint = "/conversations/saved";
  const first = await (await before.call(owner.token, endpoint + "/messages", turn("one", "First turn."))).json();
  await until(() => fixture.runtime.status(first.taskId), (s) => s.messages.some((m) => m.role === "assistant"));
  const follow = await (await before.call(owner.token, endpoint + "/messages", turn("two", "Follow-up."))).json();
  await until(() => fixture.runtime.status(first.taskId), (s) => s.messages.filter((m) => m.role === "assistant").length >= 2);
  await before.close();
  await fixture.runtime.close();
  const files = join(directory, "conversations", sha("owner"));
  const recordPath = join(files, sha("saved") + ".json");
  const record = JSON.parse(await readFile(recordPath, "utf8"));
  record.receipts[1].state = "accepted";
  const interruptedId = "33b0cdfd-6980-4e6d-ac87-ab126c2accb1";
  record.receipts.push({
    messageId: "three", requestId: interruptedId,
    fingerprint: sha(JSON.stringify(["A message never dispatched.", []])), state: "accepted",
  });
  await writeFile(recordPath, JSON.stringify(record));
  restarted = new LocalRuntime(fixture.settings, { models: fixture.models });
  const after = await portal(t, restarted, directory, [owner.device]);
  closeAfter = after.close;
  const recovered = await after.call(owner.token, endpoint);
  const latest = await recovered.json();
  assert.equal(recovered.status, 200, JSON.stringify(latest));
  assert.equal(latest.taskId, first.taskId);
  assert.equal(latest.receipts[1].requestId, follow.requestId);
  assert.equal(latest.receipts[1].state, "submitted");
  assert.equal(latest.receipts[2].state, "interrupted");
  const replay = await (await after.call(owner.token, endpoint + "/messages", turn("three", "A message never dispatched."))).json();
  assert.equal(replay.requestId, interruptedId);
  assert.equal(replay.state, "interrupted");
  assert.equal((await after.call(owner.token, endpoint + "?messageId=not-sent").then((res) => res.json())).state, "unknown");
  assert.deepEqual(latest.messages.map((m: { text: string }) => m.text), ["First turn.", "Saved reply.", "Follow-up.", "Saved reply."]);
  assert.equal((await restarted.list()).length, 1);
});

test("D04 polling the original chat returns ordered replies without duplication", async (t) => {
  let replies = 0;
  const fixture = await scriptedFixture(() => fauxAssistantMessage(++replies === 1 ? "What should I call the file?" : "I will use report.txt."));
  t.after(() => fixture.close());
  const owner = pairing();
  const { call } = await portal(t, fixture.runtime, join(fixture.directory, "remote"), [owner.device]);
  const path = "/conversations/poll";
  const view = async () => (await call(owner.token, path)).json();
  const one = await (await call(owner.token, path + "/messages", turn("prompt", "I have a file request."))).json();
  const before = await until(view, (state) => state.messages.some((message: { text: string }) => message.text === "What should I call the file?"));
  const two = await (await call(owner.token, path + "/messages", turn("answer", "report.txt"))).json();
  assert.equal(two.taskId, one.taskId);
  const after = await until(view, (state) => state.messages.some((message: { text: string }) => message.text === "I will use report.txt."));
  assert.deepEqual(after.messages.slice(0, before.messages.length), before.messages);
  assert.deepEqual(after.messages.map((message: { text: string }) => message.text), [
    "I have a file request.", "What should I call the file?", "report.txt", "I will use report.txt.",
  ]);
  const sequence: number[] = after.messages.map((message: { sequence: number }) => message.sequence);
  assert.deepEqual(sequence, [...new Set(sequence)].sort((a, b) => a - b));
  assert.deepEqual(await view(), after);
});

test("F14 remote history preserves messages and sequence IDs after native compaction and reopen", async (t) => {
  const fixture = await scriptedFixture((context) => context.messages.some((message) =>
    message.role === "system" && JSON.stringify(message).includes("context summarization assistant"))
    ? fauxAssistantMessage("PRIVATE_COMPACTION_SUMMARY") : fauxAssistantMessage("Saved reply."));
  let restarted: LocalRuntime | undefined;
  t.after(async () => { await restarted?.close(); await fixture.close(); });
  const owner = pairing();
  const directory = join(fixture.directory, "remote");
  const before = await portal(t, fixture.runtime, directory, [owner.device]);
  const path = "/conversations/compaction";
  const first = await (await before.call(owner.token, path + "/messages", turn("one", "First turn."))).json();
  await until(() => fixture.runtime.status(first.taskId), (state) => state.status === "answered");
  await before.call(owner.token, path + "/messages", turn("two", "Second turn."));
  const saved = await until(async () => (await before.call(owner.token, path)).json(), (state) => state.messages.length === 4);
  await before.close();
  await fixture.runtime.close();
  const storage = await openNodeSqliteStorage(join(fixture.directory, "tasks", first.taskId, "session.sqlite"));
  const harness = await Harness.open(storage, { models: fixture.models, registry: createRegistry(),
    settings: { compaction: { enabled: true, keepRecentTokens: 256, backgroundTokens: 0 } } }, ctx);
  try {
    const root = await harness.root(ctx);
    await harness.commit(async (tx) => {
      for (let index = 0; index < 220; index++) await tx.appendEntry(root.id, { kind: "test.note", data: { index } });
    }, ctx);
    for (let chunk = 0; chunk < 2; chunk++) {
      const written = await root.submit({ type: "write", entry: { kind: UserEntry.kind,
        model: [{ role: "user", content: "Archived reference material. ".repeat(3000), timestamp: Date.now() }] } }, ctx);
      assert.equal((await written.wait(ctx)).status, "done");
    }
    const compaction = await root.compact("Keep saved replies.", ctx);
    const result = (await harness.waitForTask(compaction, ctx)).state.outcome;
    assert.equal(result.status, "completed");
    assert(result.status === "completed" && result.result.submissionId !== undefined);
    assert.equal((await (await harness.submission(result.result.submissionId, ctx))!.wait(ctx)).status, "done");
    assert.equal((await root.context(ctx)).entries.filter((entry) => entry.kind === "pi.compaction").length, 1);
  } finally { await harness.close(ctx); }
  restarted = new LocalRuntime(fixture.settings, { models: fixture.models });
  const after = await portal(t, restarted, directory, [owner.device]);
  const view = await (await after.call(owner.token, path)).json();
  assert.deepEqual(view.messages.slice(0, saved.messages.length), saved.messages);
  assert.equal(view.messages.length, 6);
  assert(!view.messages.some((message: { text: string }) => message.text === "PRIVATE_COMPACTION_SUMMARY"));
  const sequences: number[] = view.messages.map((message: { sequence: number }) => message.sequence);
  assert.deepEqual(sequences, [...new Set(sequences)].sort((a, b) => a - b));
  assert(sequences.at(-1)! > 220, "sequence IDs come from native durable entries, including gaps");
  assert.deepEqual((await (await after.call(owner.token, path)).json()).messages, view.messages);
});

function upload(bytes: Buffer, name: string, type = "application/octet-stream", hash = sha(bytes)): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": type, "X-Kada-Filename": encodeURIComponent(name), "X-Kada-Sha256": hash },
    body: new Uint8Array(bytes),
  };
}

test("D05 upload rejects invalid, cross-conversation, oversized, and expired inputs", async (t) => {
  const fixture = await scriptedFixture(() => fauxAssistantMessage("Received."));
  t.after(() => fixture.close());
  const owner = pairing();
  const directory = join(fixture.directory, "remote");
  const { call } = await portal(t, fixture.runtime, directory, [owner.device]);
  const path = "/conversations/attachments";
  assert.equal((await call(owner.token, path + "/uploads", upload(Buffer.from("bytes"), "../escape.txt"))).status, 400);
  assert.equal((await call(owner.token, path + "/uploads", upload(Buffer.from("bytes"), "NUL.txt"))).status, 400);
  assert.equal((await call(owner.token, path + "/uploads", upload(Buffer.from("not an image"), "picture.png", "image/png"))).status, 415);
  assert.equal((await call(owner.token, path + "/uploads", upload(Buffer.from("x"), "page.html", "text/html"))).status, 415);
  assert.equal((await call(owner.token, path + "/uploads", upload(Buffer.from("x"), "a.txt", "text/plain", sha("y")))).status, 422);
  assert.equal((await call(owner.token, path + "/uploads", upload(Buffer.alloc(5 * 1024 * 1024 + 1), "large.bin"))).status, 413);
  const valid = await (await call(owner.token, path + "/uploads", upload(Buffer.from("one,two\n"), "table.csv", "text/csv"))).json();
  assert.match(valid.id, /^[\da-f-]{36}$/);
  assert.equal((await call(owner.token, "/conversations/other/messages", turn("one", "Use it", [valid.id]))).status, 422);
  const recordPath = join(directory, "conversations", sha("owner"), sha("attachments") + ".json");
  const record = JSON.parse(await readFile(recordPath, "utf8"));
  record.uploads[0].expiresAt = Date.now() - 1;
  await writeFile(recordPath, JSON.stringify(record));
  assert.equal((await call(owner.token, path + "/messages", turn("one", "Use it", [valid.id]))).status, 422);
  assert.equal((await fixture.runtime.list()).length, 0);
});

const tool = (name: string, args: Record<string, unknown>) =>
  fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

test("F13 remote native reads cannot disclose a sibling conversation before confirmation", async (t) => {
  let sibling = "";
  const offered: string[][] = [];
  const fixture = await scriptedFixture((context) => {
    offered.push(getCurrentTools(context.messages).map((entry) => entry.name));
    return context.messages.some((message) => message.role === "toolResult")
      ? fauxAssistantMessage("The read was refused.") : tool("read", { path: sibling });
  });
  t.after(() => fixture.close());
  sibling = join(fixture.directory, "sibling-conversation.txt");
  await writeFile(sibling, "SIBLING_PRIVATE_SYNTHETIC");
  const owner = pairing();
  const { call } = await portal(t, fixture.runtime, join(fixture.directory, "remote"), [owner.device]);
  const response = await (await call(owner.token, "/conversations/isolation/messages", turn("one", "Read the supplied file."))).json();
  const status = await until(() => fixture.runtime.status(response.taskId), (value) => value.messages.some((message) => message.role === "toolResult"));
  const result = status.messages.find((message) => message.role === "toolResult");
  assert.equal(result?.role === "toolResult" && result.isError, true);
  assert(!JSON.stringify(result).includes("SIBLING_PRIVATE_SYNTHETIC"));
  assert(offered.every((tools) => !tools.some((name) => /^(?:memory_|user_remember$|user_memory_|bash$|task_verify$|run_skill_script$)/.test(name))));
});

test("F13 confirmed remote tasks and Pi children retain file isolation without owner capabilities", async (t) => {
  let sibling = "";
  let prepareRead = false;
  let executionStep = 0;
  const offered: string[][] = [];
  const blocked: { worker: boolean; name: string; failed: boolean }[] = [];
  const seen = new Set<string>();
  const fixture = await scriptedFixture((context) => {
    const tools = getCurrentTools(context.messages).map((entry) => entry.name);
    offered.push(tools);
    const worker = !tools.includes("task_prepare") && !tools.includes("task_submit");
    for (const message of context.messages) if (message.role === "toolResult" && ["read", "write", "edit"].includes(message.toolName) && !seen.has(message.toolCallId)) {
      seen.add(message.toolCallId);
      blocked.push({ worker, name: message.toolName, failed: message.isError });
    }
    if (worker) {
      if (!context.messages.some((message) => message.role === "toolResult")) return tool("read", { path: sibling });
      return fauxAssistantMessage("The child refused the sibling read.");
    }
    if (tools.includes("task_prepare")) {
      if (!prepareRead) { prepareRead = true; return tool("read", { path: sibling }); }
      return tool("task_prepare", { outcome: "Create a workspace report.", deliverables: ["report.txt"], inputs: [], scope: ["This conversation"],
        assumptions: [], questions: [], criteria: [{ text: "Inspect the report", method: "inspect" }] });
    }
    switch (executionStep++) {
      case 0: return tool("read", { path: sibling });
      case 1: return tool("write", { path: sibling, content: "replacement" });
      case 2: return tool("edit", { path: sibling, oldText: "SIBLING_PRIVATE_SYNTHETIC", newText: "replacement" });
      case 3: return tool("delegate", { tasks: [{ name: "isolated-child", instructions: "Read the supplied sibling file, then report whether that capability was refused." }] });
      case 4: return tool("write", { path: "report.txt", content: "A workspace report." });
      default: return tool("task_submit", { summary: "Created the workspace report.", artifacts: ["report.txt"],
        criteria: [{ id: 1, status: "passed", evidence: "Inspected the report." }] });
    }
  }, { discovery: true, learning: true, web: true }, () => [defineExtension({ name: "owner_private_capabilities", tools: [defineTool({ name: "user_remember", description: "Owner memory fixture.",
    parameters: Type.Object({}), execute: async () => ({ output: [{ type: "text", text: "OWNER_PRIVATE_MEMORY" }] }),
  })] })]);
  t.after(() => fixture.close());
  sibling = join(fixture.directory, "sibling-conversation.txt");
  await writeFile(sibling, "SIBLING_PRIVATE_SYNTHETIC");
  const owner = pairing();
  const { call } = await portal(t, fixture.runtime, join(fixture.directory, "remote"), [owner.device]);
  const path = "/conversations/confirmed-isolation";
  const receipt = await (await call(owner.token, path + "/messages", turn("one", "Create a workspace report."))).json();
  const view = async () => (await call(owner.token, path)).json();
  const brief = await until(view, (state) => state.task?.status === "awaiting_confirmation");
  assert(!offered.flat().includes("user_remember"));
  assert(offered.every((tools) => !tools.some((name) => ["write", "edit", "copy_file", "delegate"].includes(name))));
  const meta = await fixture.runtime.metadata(receipt.taskId);
  assert.equal(meta.remotePolicy, "workspace");
  assert.equal(meta.discovery, undefined);
  assert.equal(meta.userMemory, undefined);
  assert.equal(meta.learning, undefined);
  assert.deepEqual(meta.skillSelection, []);
  assert.deepEqual(meta.mcpPins, []);
  assert.equal((await call(owner.token, path + "/confirm", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ revision: brief.task.brief.revision, digest: brief.task.briefDigest }) })).status, 200);
  await until(view, (state) => state.task?.status === "completed");
  const status = await fixture.runtime.status(receipt.taskId);
  assert.equal(await readFile(sibling, "utf8"), "SIBLING_PRIVATE_SYNTHETIC");
  assert.equal(await readFile(join(status.workspace, "report.txt"), "utf8"), "A workspace report.");
  assert(blocked.some((entry) => entry.worker && entry.name === "read" && entry.failed));
  assert(blocked.filter((entry) => !entry.worker && entry.name === "read").every((entry) => entry.failed));
  assert(blocked.some((entry) => entry.name === "write" && entry.failed));
  assert(blocked.some((entry) => entry.name === "edit" && entry.failed));
  assert(offered.every((tools) => !tools.some((name) => /^(?:user_remember$|user_memory_|bash$|task_verify$|run_skill_script$)/.test(name))));
  assert.equal(status.delegations.length, 1);
});

test("F13 historical conversations without a saved workspace policy cannot reopen or confirm", async (t) => {
  const fixture = await scriptedFixture(() => fauxAssistantMessage("Saved reply."));
  let restarted: LocalRuntime | undefined;
  t.after(async () => { await restarted?.close(); await fixture.close(); });
  const owner = pairing();
  const directory = join(fixture.directory, "remote");
  const before = await portal(t, fixture.runtime, directory, [owner.device]);
  const path = "/conversations/historical";
  const receipt = await (await before.call(owner.token, path + "/messages", turn("one", "Hello."))).json();
  await until(() => fixture.runtime.status(receipt.taskId), (state) => state.status === "answered");
  await before.close();
  await fixture.runtime.close();
  const metaPath = join(fixture.directory, "tasks", receipt.taskId, "task.json");
  const meta = JSON.parse(await readFile(metaPath, "utf8"));
  delete meta.remotePolicy;
  await writeFile(metaPath, JSON.stringify(meta));
  restarted = new LocalRuntime(fixture.settings, { models: fixture.models });
  const after = await portal(t, restarted, directory, [owner.device]);
  const history = await after.call(owner.token, path);
  assert.equal(history.status, 409);
  assert.match((await history.json()).error, /Start a new conversation/);
  assert.equal((await after.call(owner.token, path + "/messages", turn("two", "Continue."))).status, 409);
  assert.equal((await after.call(owner.token, path + "/confirm", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ revision: 1, digest: "1".repeat(64) }) })).status, 409);
  assert.equal(JSON.parse(await readFile(metaPath, "utf8")).remotePolicy, undefined);
});

test("F13 startup quarantines a legacy remote admission before recovery can run tools", async (t) => {
  let modelCalls = 0;
  let toolCalls = 0;
  let sibling = "";
  const fixture = await scriptedFixture((context) => {
    modelCalls++;
    if (!context.messages.some((message) => message.role === "toolResult")) return tool("read", { path: sibling });
    toolCalls++;
    return fauxAssistantMessage("Recovered the pending chat.");
  });
  let restarted: LocalRuntime | undefined;
  t.after(async () => { await restarted?.close(); await fixture.close(); });
  const owner = pairing();
  const directory = join(fixture.directory, "remote");
  const id = "11111111-1111-4111-8111-111111111111";
  const workspace = join(directory, "workspaces", id);
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, ".kada-project"), "");
  sibling = join(fixture.directory, "owner-secret.txt");
  await writeFile(sibling, "OWNER_PRIVATE_SYNTHETIC");
  const taskDirectory = join(fixture.directory, "tasks", id);
  await mkdir(taskDirectory, { recursive: true });
  // Crash window: HTTP admission and task metadata are durable, Pi's initial submission is not.
  const meta = { id, objective: "Read the supplied file.", workspace, model: fixture.settings.model,
    createdAt: Date.now(), deadlineAt: Date.now() + 30000, maxSubagents: 2, control: "active", schemaVersion: 3,
    planPolicy: "advisory", preparation: true, entrypoint: "chat", maxEstimatedCostUsd: 1, skillSelection: [], mcpPins: [] };
  await writeFile(join(taskDirectory, "task.json"), JSON.stringify(meta));
  const accountDirectory = join(directory, "conversations", sha("owner"));
  await mkdir(accountDirectory, { recursive: true });
  const recordPath = join(accountDirectory, sha("legacy-startup") + ".json");
  const record = JSON.stringify({ channel: "web", accountId: "owner", deviceId: "phone", conversationId: "legacy-startup", taskId: id,
    title: "Legacy pending chat", updatedAt: Date.now(), uploads: [], receipts: [{ messageId: "one", requestId: "pending-one", fingerprint: sha("request"), state: "accepted" }] });
  await writeFile(recordPath, record);
  const missingPath = join(accountDirectory, sha("missing-admission") + ".json");
  const missing = JSON.stringify({ channel: "web", accountId: "owner", deviceId: "phone", conversationId: "missing-admission",
    taskId: "22222222-2222-4222-8222-222222222222", title: "Not admitted", updatedAt: Date.now(), uploads: [],
    receipts: [{ messageId: "one", requestId: "pending-two", fingerprint: sha("request"), state: "accepted" }] });
  await writeFile(missingPath, missing);
  await fixture.runtime.close();
  restarted = new LocalRuntime(fixture.settings, { models: fixture.models });
  await quarantineLegacyRemoteTasks(restarted, directory);
  await restarted.recover();
  assert.equal((await restarted.metadata(id)).control, "paused");
  assert.equal(modelCalls, 0);
  assert.equal(toolCalls, 0);
  assert.equal(await readFile(recordPath, "utf8"), record);
  assert.equal(await readFile(missingPath, "utf8"), missing);
  assert.equal(await readFile(sibling, "utf8"), "OWNER_PRIVATE_SYNTHETIC");
  const after = await portal(t, restarted, directory, [owner.device]);
  assert.equal((await after.call(owner.token, "/conversations/legacy-startup")).status, 409);
  const receipt = await (await after.call(owner.token, "/conversations/missing-admission?messageId=one")).json();
  assert.equal(receipt.state, "interrupted");
  assert.equal(modelCalls, 0);
});

test("F13 startup quarantine leaves scoped and inactive tasks unchanged and is idempotent", async (t) => {
  const fixture = await scriptedFixture(() => { throw new Error("Quarantine must not start a model."); });
  t.after(() => fixture.close());
  const directory = join(fixture.directory, "remote");
  await quarantineLegacyRemoteTasks(fixture.runtime, directory);
  const accountDirectory = join(directory, "conversations", sha("owner"));
  await mkdir(accountDirectory, { recursive: true });
  const cases = [
    { control: "active", expected: "paused", record: true },
    { control: "active", expected: "active", record: true, remotePolicy: "workspace" },
    { control: "paused", expected: "paused", record: true },
    { control: "budget_limited", expected: "budget_limited", record: true },
    { control: "cancelled", expected: "cancelled", record: true },
    { control: "active", expected: "active", record: false },
  ];
  for (const [index, entry] of cases.entries()) {
    const id = `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`;
    const taskDirectory = join(fixture.directory, "tasks", id);
    await mkdir(taskDirectory, { recursive: true });
    await writeFile(join(taskDirectory, "task.json"), JSON.stringify({ id, control: entry.control, remotePolicy: entry.remotePolicy }));
    if (entry.record) await writeFile(join(accountDirectory, sha("chat-" + index) + ".json"), JSON.stringify({
      channel: "web", accountId: "owner", deviceId: "phone", conversationId: "chat-" + index, taskId: id, receipts: [], uploads: [],
    }));
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    await quarantineLegacyRemoteTasks(fixture.runtime, directory);
    for (const [index, entry] of cases.entries()) {
      const id = `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`;
      const meta = await fixture.runtime.metadata(id);
      assert.equal(meta.control, entry.expected);
      assert.equal(meta.remotePolicy, entry.remotePolicy);
    }
  }
});

test("F15 artifact URLs identify the verified delivery and preserve directory member downloads", async (t) => {
  let stage = "prepare";
  const fixture = await scriptedFixture(() => {
    if (stage === "prepare") {
      stage = "awaiting";
      return tool("task_prepare", { outcome: "Deliver files.", deliverables: ["A verified file"], inputs: [],
        scope: ["Workspace files"], assumptions: [], questions: [], criteria: [{ text: "Inspect the files", method: "inspect" }] });
    }
    if (stage === "first-write") { stage = "first-submit"; return tool("write", { path: "first.txt", content: "first delivery" }); }
    if (stage === "second-empty") { stage = "second-write"; return tool("write", { path: "bundle/empty.txt", content: "" }); }
    if (stage === "second-write") { stage = "second-submit"; return tool("write", { path: "bundle/report.txt", content: "second delivery" }); }
    if (stage.endsWith("-submit")) {
      const first = stage === "first-submit";
      stage = "idle";
      return tool("task_submit", { summary: first ? "First delivery." : "Second delivery.", artifacts: [first ? "first.txt" : "bundle"],
        criteria: [{ id: 1, status: "passed", evidence: "Inspected the written workspace files." }] });
    }
    return fauxAssistantMessage("Waiting for confirmation.");
  });
  t.after(() => fixture.close());
  const owner = pairing();
  const { call } = await portal(t, fixture.runtime, join(fixture.directory, "remote"), [owner.device]);
  const path = "/conversations/artifact-version";
  await call(owner.token, path + "/messages", turn("one", "Deliver a file."));
  const view = async () => (await call(owner.token, path)).json();
  const brief = await until(view, (value) => value.task?.status === "awaiting_confirmation");
  stage = "first-write";
  assert.equal((await call(owner.token, path + "/confirm", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ revision: brief.task.brief.revision, digest: brief.task.briefDigest }) })).status, 200);
  const first = await until(view, (value) => value.task?.status === "completed");
  const fetchArtifact = (href: string) => call(owner.token, href.replace(/^\/remote\/api/, ""));
  const oldHref = first.task.delivery.artifacts[0].href;
  assert.equal(await (await fetchArtifact(oldHref)).text(), "first delivery");
  stage = "second-empty";
  assert.equal((await call(owner.token, path + "/messages", turn("two", "Deliver a directory with an empty file and a report."))).status, 202);
  const second = await until(view, (value) => value.task?.status === "completed" && value.task.delivery?.summary === "Second delivery.");
  const currentHref = second.task.delivery.artifacts[0].href;
  assert.equal((await fetchArtifact(oldHref)).status, 404, "an old link must not select a new occupant at artifact index zero");
  assert.notEqual(currentHref, oldHref);
  const directory = await (await fetchArtifact(currentHref)).json();
  assert.equal(directory.files.length, 2);
  for (const file of directory.files) {
    const output = await fetchArtifact(file.href);
    assert.equal(output.status, 200);
    const text = await output.text();
    assert.equal(text, file.path === "empty.txt" ? "" : "second delivery");
    assert.equal(output.headers.get("X-Kada-SHA256"), sha(text));
  }
});

test("D06 mobile approval and a verified artifact preserve the attachment’s binary bytes", async (t) => {
  const original = Buffer.from([0, 1, 13, 10, 128, 254, 255]);
  let stage = "prepare";
  let attachmentId = "";
  const fixture = await scriptedFixture(async (context) => {
    if (stage === "prepare" && hasTool(context, "task_prepare")) {
      stage = "awaiting";
      return tool("task_prepare", {
        outcome: "Copy the supplied file byte-for-byte.",
        deliverables: ["copy.bin"], inputs: ["Attached source bytes"],
        scope: ["Use this conversation workspace"], assumptions: [], questions: [],
        criteria: [{ text: "copy.bin matches the source bytes", method: "inspect" }],
      });
    }
    if (stage === "approved" && hasTool(context, "task_submit")) {
      stage = "copied";
      return tool("copy_file", { source: "attachments/" + attachmentId + "/source.bin", destination: "copy.bin" });
    }
    if (stage === "copied" && hasTool(context, "task_submit")) {
      stage = "submitted";
      return tool("task_submit", {
        summary: "Copied the binary file.", artifacts: ["copy.bin"],
        criteria: [{ id: 1, status: "passed", evidence: "Compared the attached source bytes and resulting bytes." }],
      });
    }
    return fauxAssistantMessage("The delivery details are available.");
  });
  t.after(() => fixture.close());
  const owner = pairing();
  const { call } = await portal(t, fixture.runtime, join(fixture.directory, "remote"), [owner.device]);
  const path = "/conversations/binary";
  const attachment = await call(owner.token, path + "/uploads", upload(original, "source.bin"));
  assert.equal(attachment.status, 201);
  const uploaded = await attachment.json();
  attachmentId = uploaded.id;
  assert.equal(uploaded.sha256, sha(original));
  const response = await call(owner.token, path + "/messages", turn("copy", "Return an exact copy of the attached file.", [attachmentId]));
  assert.equal(response.status, 202);
  const receipt = await response.json();
  const workspace = (await fixture.runtime.status(receipt.taskId)).workspace;
  assert.deepEqual(await readFile(join(workspace, "attachments", attachmentId, "source.bin")), original);
  assert.deepEqual(await (await call(owner.token, path + "/messages", turn("copy", "Return an exact copy of the attached file.", [attachmentId]))).json(), receipt);
  const view = async () => (await call(owner.token, path)).json();
  const brief = await until(view, (state) => state.task?.status === "awaiting_confirmation");
  assert.equal(brief.task.confirmed, false);
  assert.equal(brief.task.delivery, null);
  assert.equal((await call(owner.token, path + "/artifacts/0")).status, 404);
  const confirmation = (digest: string) => ({
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ revision: brief.task.brief.revision, digest }),
  });
  assert.equal((await call(owner.token, path + "/confirm", confirmation("1".repeat(64)))).status, 409);
  stage = "approved";
  assert.equal((await call(owner.token, path + "/confirm", confirmation(brief.task.briefDigest))).status, 200);
  const finished = await until(view, (state) => state.task?.status === "completed");
  assert.equal(finished.task.delivery.summary, "Copied the binary file.");
  assert.equal(finished.task.delivery.artifacts[0].sha256, sha(original));
  const artifactHref = finished.task.delivery.artifacts[0].href.replace(/^\/remote\/api/, "");
  const output = await call(owner.token, artifactHref);
  assert.equal(output.status, 200);
  assert.equal(output.headers.get("X-Kada-SHA256"), sha(original));
  assert.deepEqual(Buffer.from(await output.arrayBuffer()), original);
  await writeFile(join(workspace, "copy.bin"), Buffer.alloc(original.length, 7));
  assert.equal((await call(owner.token, artifactHref)).status, 409);
});
