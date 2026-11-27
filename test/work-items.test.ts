import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { WorkItems, type WorkItemLink, type WorkItemRun } from "../src/work-items.js";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { serve } from "../src/server.js";
import { hasTool, scriptedFixture, until } from "./helpers.js";

async function directories(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "kada-work-items-"));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 3 }));
  const project = join(directory, "project");
  const workspace = join(project, "src");
  const other = join(directory, "another-project");
  await Promise.all([mkdir(workspace, { recursive: true }), mkdir(join(project, ".git"), { recursive: true }), mkdir(other)]);
  return { directory, project, workspace, other };
}

type Run = WorkItemRun & { objective: string; workspace: string; confirmed: boolean };

test("a paired editor updates one original work item with its revision and a durable receipt", async t => {
  const { directory, workspace } = await directories(t);
  const fixture = await scriptedFixture(() => fauxAssistantMessage('No work item run should start.'));
  t.after(() => fixture.close());
  const socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const server = await serve({ ...fixture.settings, port, dataDir: directory }, { models: fixture.models });
  try {
    const base = `http://127.0.0.1:${port}`, ownerToken = (await readFile(join(directory, "token"), "utf8")).trim();
    const request = (path: string, bearer: string, method = 'GET', input?: unknown) => fetch(base + path, {
      method, headers: { Authorization: 'Bearer ' + bearer, 'Content-Type': 'application/json' },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    const card = await server.runtime.workItems.create({ workspace, title: 'Original title', objective: 'Original work.' });
    const pairing = { accountId: 'owner', deviceId: 'editor' };
    const grant = (kind: string) => request('/v1/work-items/' + card.id + '/' + kind, ownerToken, 'POST', pairing);
    const phone = await (await request('/v1/remote/devices', ownerToken, 'POST', pairing)).json();
    const path = '/remote/api/work-items/' + card.id;
    const edit = { revision: card.revision, requestId: 'mobile-update', title: 'Edited on phone', priority: 'urgent' };
    assert.equal((await grant('share-edits')).status, 409);
    assert.equal((await grant('share')).status, 200);
    assert.equal((await request(path, phone.token, 'PATCH', edit)).status, 403);
    assert.equal((await grant('share-edits')).status, 200);
    assert.equal((await (await request(path, phone.token)).json()).canEdit, true);
    assert.equal((await request(path, phone.token, 'PATCH', { ...edit, assignee: null })).status, 400);
    assert.equal((await request(path, phone.token, 'PATCH', { ...edit, revision: 2 })).status, 409);
    const changed = await (await request(path, phone.token, 'PATCH', edit)).json();
    assert.equal(changed.id, card.id);
    assert.equal(changed.title, edit.title);
    assert.equal(changed.priority, edit.priority);
    assert.equal(changed.revision, 2);
    assert(!Object.hasOwn(changed, 'workspace'));
    await server.runtime.workItems.update(card.id, { revision: 2, title: 'Later owner edit' });
    assert.deepEqual(await (await request(path, phone.token, 'PATCH', edit)).json(), changed);
    assert.equal((await server.runtime.workItems.get(card.id)).title, 'Later owner edit');
    assert.deepEqual(await server.runtime.workItems.runs(card.id), []);
    assert.equal((await grant('unshare')).status, 200);
    assert.equal((await request(path, phone.token, 'PATCH', edit)).status, 404);
    assert.equal((await grant('share')).status, 200);
    assert.equal((await request(path, phone.token, 'PATCH', edit)).status, 403);
  } finally { await server.close(); }
});

test("the authenticated work item API replays original tasks after editing and restarting", async t => {
  const { directory, project, workspace, other } = await directories(t);
  const fixture = await scriptedFixture(() => fauxAssistantMessage(
    fauxToolCall("task_submit", { summary: "Verified inventory", artifacts: [] }), { stopReason: "toolUse" },
  ));
  t.after(() => fixture.close());
  const socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const open = () => serve({ ...fixture.settings, port, dataDir: directory }, { models: fixture.models });
  let server = await open();
  const base = `http://127.0.0.1:${port}/v1/work-items`;
  try {
    const token = (await readFile(join(directory, "token"), "utf8")).trim();
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const request = (path: string, method = "GET", value?: object) => fetch(base + path, {
      method, headers, ...(value ? { body: JSON.stringify(value) } : {}),
    });
    const item = { workspace, title: "Audit inventory", objective: "Verify the inventory", priority: 'high', dueDate: '2099-12-01', timeZone: 'America/New_York' };
    assert.equal((await fetch(base, { method: "POST", body: JSON.stringify(item) })).status, 401);
    const created = await request("", "POST", item);
    assert.equal(created.status, 201);
    const saved = await created.json() as { id: string; revision: number };
    const path = "/" + saved.id;
    const run = { revision: saved.revision, requestId: "http-run", confirmed: true };
    assert.deepEqual(await (await request("?workspace=" + encodeURIComponent(project))).json(), [saved]);
    assert.deepEqual(await (await request("?workspace=" + encodeURIComponent(other))).json(), []);
    const admission = t.mock.method(server.runtime, "open", async () => {
      throw new Error("Synthetic failure after the run metadata was saved");
    });
    const interrupted = await request(path + "/runs", "POST", run);
    assert.equal(interrupted.status, 400);
    assert.match((await interrupted.json()).error, /Synthetic failure/);
    admission.mock.restore();
    const recorded = await (await request(path + "/runs")).json() as WorkItemRun[];
    assert.equal(recorded.length, 1);
    const response = await request(path + "/runs", "POST", run);
    assert.equal(response.status, 201);
    const first = await response.json() as WorkItemRun;
    assert.equal(first.id, recorded[0]?.id);
    assert.deepEqual(first.workItem, { id: saved.id, revision: 1 });
    await until(() => server.runtime.status(first.id), task => task.status === "completed");
    assert.equal((await request(path, "PATCH", { revision: 1, objective: "Audit the updated inventory" })).status, 200);
    await server.close();
    server = await open();
    const replay = await request(path + "/runs", "POST", run);
    assert.equal(replay.status, 201);
    assert.deepEqual(await replay.json(), first);
    assert.equal((await request(path + "/runs", "POST", { ...run, confirmed: false })).status, 409);
    assert.equal((await request(path + "/runs", "POST", { ...run, requestId: "stale-new" })).status, 409);
    assert.deepEqual(await (await request(path + "/runs")).json(), [first]);
  } finally { await server.close(); }
});

test("a paired phone reads shared runs and answers only their authorized current questions across restart", async t => {
  const { directory, workspace } = await directories(t);
  let needsInput = true;
  const fixture = await scriptedFixture(() => fauxAssistantMessage(
    needsInput
      ? fauxToolCall("task_blocked", { reason: "Inventory date missing", question: "Which date should I use?" })
      : fauxToolCall("task_submit", { summary: "Inventory verified", artifacts: [] }),
    { stopReason: "toolUse" },
  ));
  t.after(() => fixture.close());
  const socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const open = () => serve({ ...fixture.settings, port, dataDir: directory }, { models: fixture.models });
  let server = await open();
  try {
    const adminToken = (await readFile(join(directory, "token"), "utf8")).trim();
    const request = (token: string, path: string, method = "GET", value?: object) => fetch("http://127.0.0.1:" + port + path, {
      method, headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: value === undefined ? undefined : JSON.stringify(value),
    });
    const owner = (path: string, method: string, value?: object) => request(adminToken, path, method, value);
    const pair = async (deviceId: string) => (await (await owner("/v1/remote/devices", "POST", { accountId: "owner", deviceId })).json()).token;
    const phone = await pair("phone");
    const tablet = await pair("tablet");
    const item = await server.runtime.workItems.create({ workspace, title: "Inventory", objective: "Verify the inventory", priority: 'high', dueDate: '2000-12-01', timeZone: 'America/New_York' });
    const privateItem = await server.runtime.workItems.create({ workspace, title: "Private item", objective: "Private objective" });
    const waiting = await server.runtime.workItems.run(item.id, { revision: item.revision, requestId: "early-run", confirmed: true });
    await until(() => server.runtime.status(waiting.id), status => status.status === "waiting_user");
    const remote = "/remote/api/work-items";
    const details = remote + "/" + item.id;
    const share = "/v1/work-items/" + item.id + "/share";
    const recipient = { accountId: "owner", deviceId: "phone" };
    const before = await request(phone, remote);
    assert.equal(before.status, 200);
    assert.deepEqual(await before.json(), []);
    assert.equal((await request(phone, details)).status, 404);
    assert.equal((await request(tablet, share, "POST", recipient)).status, 401);
    assert.equal((await owner(share, "POST", recipient)).status, 200);
    const updated = await server.runtime.workItems.update(item.id, { revision: item.revision, objective: "Verify the latest inventory" });
    needsInput = false;
    const run = await server.runtime.workItems.run(item.id, { revision: updated.revision, requestId: "later-run", confirmed: true });
    await until(() => server.runtime.status(run.id), status => status.status === "completed");
    const privateRun = await server.runtime.workItems.run(privateItem.id, {
      revision: privateItem.revision, requestId: "private-run", confirmed: true,
    });
    await until(() => server.runtime.status(privateRun.id), status => status.status === "completed");
    await server.close();
    server = await open();
    const { id, title, revision, updatedAt, objective, status, archived, completedAt } = updated;
    const planning = { priority: 'high', dueDate: '2000-12-01', dueAt: null, timeZone: 'America/New_York', overdue: true };
    assert.deepEqual(await (await request(phone, remote)).json(), [{ id, title, revision, updatedAt, status, archived, completedAt, ...planning }]);
    assert.deepEqual(await (await request(phone, details)).json(), { id, title, revision, updatedAt, objective, status, archived, completedAt, ...planning,
      runs: [
        { id: waiting.id, revision: item.revision, status: "waiting_user", reason: "Inventory date missing", question: "Which date should I use?", summary: null },
        { id: run.id, revision, status: "completed", reason: null, question: null, summary: "Inventory verified" },
      ],
    });
    assert.equal((await request(phone, remote + "/" + privateItem.id)).status, 404);
    assert.equal((await request(tablet, details)).status, 404);
    const runDetails = details + "/runs/" + waiting.id;
    const opened = await request(phone, runDetails);
    assert.equal(opened.status, 200);
    assert.deepEqual(await opened.json(), {
      id: waiting.id, revision: item.revision, objective: item.objective, status: "waiting_user",
      reason: "Inventory date missing", question: "Which date should I use?", summary: null, steps: [], childQuestions: [], answerVersion: null,
      controls: [], controlVersion: null,
    });
    assert.equal((await request(tablet, runDetails)).status, 404);
    assert.equal((await request(phone, remote + "/" + privateItem.id + "/runs/" + waiting.id)).status, 404);
    assert.equal((await request(phone, details + "/runs/" + privateItem.id)).status, 404);
    await server.runtime.workItems.update(id, { revision, status: 'done', archived: true }, { requestId: 'owner-close', project: item.project });
    const closed = await (await request(phone, details)).json();
    assert.equal(closed.status, 'done'); assert.equal(closed.archived, true); assert.equal(typeof closed.completedAt, 'number'); assert.equal(closed.overdue, false);
    assert.equal(closed.runs.find((row: { id: string }) => row.id === waiting.id).status, 'waiting_user');
    assert.doesNotMatch(JSON.stringify(closed), /operations|fingerprint|owner-close/);
    const readStatus = t.mock.method(server.runtime, "status");
    try {
      assert.equal((await request(phone, details + "/runs/" + privateRun.id)).status, 404);
      assert.equal(readStatus.mock.callCount(), 0);
    } finally { readStatus.mock.restore(); }
    assert.equal((await request(phone, runDetails, "POST", {})).status, 405);
    assert.equal((await request(phone, details, "POST", {})).status, 405);
    const answers = runDetails + "/answers";
    const answer = { requestId: "inventory-answer", answer: "Use November 25.", version: "0".repeat(64) };
    assert.equal((await request(phone, answers, "POST", answer)).status, 403);
    const replies = "/v1/work-items/" + item.id + "/share-replies";
    assert.equal((await owner("/v1/work-items/" + privateItem.id + "/share-replies", "POST", recipient)).status, 409);
    assert.equal((await request(phone, replies, "POST", recipient)).status, 401);
    assert.equal((await owner(replies, "POST", recipient)).status, 200);
    const current = await (await request(phone, runDetails)).json();
    assert.match(current.answerVersion, /^[a-f0-9]{64}$/);
    answer.version = current.answerVersion;
    assert.equal((await request(tablet, answers, "POST", answer)).status, 404);
    assert.equal((await request(phone, answers.replace(waiting.id, privateRun.id), "POST", answer)).status, 404);
    for (const invalid of [{ ...answer, answer: " " }, { ...answer, answer: "a".repeat(32_001) },
      { ...answer, requestId: "../another" }, { ...answer, version: "invalid" }, { ...answer, confirmed: true }]) {
      assert.equal((await request(phone, answers, "POST", invalid)).status, 400);
    }
    assert.equal((await request(phone, answers, "POST", { ...answer, version: "0".repeat(64) })).status, 409);
    assert.equal((await owner(replies.replace(/\/share-replies$/, "/unshare-replies"), "POST", recipient)).status, 200);
    assert.equal((await request(phone, answers, "POST", answer)).status, 403);
    await owner(replies, "POST", recipient);
    await server.runtime.pause(waiting.id);
    assert.equal((await (await request(phone, runDetails)).json()).answerVersion, null);
    assert.equal((await request(phone, answers, "POST", answer)).status, 409);
    needsInput = true;
    await server.runtime.resume(waiting.id);
    await until(() => server.runtime.status(waiting.id), status => status.status === "waiting_user");
    assert.equal((await request(phone, answers, "POST", answer)).status, 409);
    answer.version = (await (await request(phone, runDetails)).json()).answerVersion;
    needsInput = false;
    const deadline = (await server.runtime.status(waiting.id)).deadlineAt;
    const expiredClock = t.mock.method(Date, "now", () => deadline + 1);
    try { assert.equal((await request(phone, answers, "POST", answer)).status, 409); }
    finally { expiredClock.mock.restore(); }
    const dispatch = t.mock.method(server.runtime, "dispatchOutbox", async () => { throw new Error("Interrupted after saving the shared answer"); });
    assert.equal((await request(phone, answers, "POST", answer)).status, 500);
    dispatch.mock.restore();
    assert.equal(Object.values((await server.runtime.status(waiting.id)).goal?.sharedAnswers ?? {})[0]?.length, 64);
    await server.close();
    server = await open();
    const accepted = await request(phone, answers, "POST", answer);
    assert.equal(accepted.status, 200, await accepted.clone().text());
    assert.deepEqual(await accepted.json(), { requestId: answer.requestId });
    assert.equal((await request(phone, answers, "POST", { ...answer, answer: "Use a different date." })).status, 409);
    const answered = await until(() => server.runtime.status(waiting.id), status => status.status === "completed");
    assert.equal(answered.goal?.revision, 2);
    assert.deepEqual(answered.goal?.userMessages, ["Use November 25."]);
    assert.equal((await (await request(phone, runDetails)).json()).answerVersion, null);
    assert.equal((await request(phone, answers, "POST", { ...answer, requestId: "new-stale-answer" })).status, 409);
    assert.equal((await request(phone, answers, "POST", answer)).status, 200);
    assert.equal((await owner(share.replace(/\/share$/, "/unshare"), "POST", recipient)).status, 200);
    assert.equal((await request(phone, details)).status, 404);
    assert.equal((await request(phone, runDetails)).status, 404);
    await owner(share, "POST", recipient);
    assert.equal((await request(phone, answers, "POST", answer)).status, 403);
    await owner("/v1/remote/devices/owner/phone", "DELETE");
    assert.equal((await request(phone, details)).status, 401);
    const replacement = await pair("phone");
    assert.equal((await request(replacement, details)).status, 404);
    assert.equal((await request(replacement, runDetails)).status, 404);
    await owner(share, "POST", recipient);
    assert.equal((await request(replacement, answers, "POST", answer)).status, 403);
  } finally { await server.close(); }
});

test("shared run controls preserve Pi state and budget while child answers target the original worker", async t => {
  const { directory, workspace } = await directories(t);
  let answers = 0;
  const tool = (name: string, args: Record<string, unknown>) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
  const fixture = await scriptedFixture(context => {
    const users = context.messages.filter(message => message.role === "user");
    if (hasTool(context, "delegation_ask")) {
      if (users.some(message => message.content === "Use USD.")) { answers++; return fauxAssistantMessage("Currency is USD."); }
      return tool("delegation_ask", { question: "Which currency?" });
    }
    if (users.some(message => String(message.content).startsWith("Background delegation finished."))) {
      return tool("task_submit", { summary: "Currency checked.", artifacts: [] });
    }
    if (context.messages.some(message => message.role === "toolResult" && message.toolName === "delegate_background")) {
      return fauxAssistantMessage("Waiting for the worker.");
    }
    return tool("delegate_background", { tasks: [{ name: "Currency worker", instructions: "Check the currency." }] });
  }, { maxDurationMs: 90_000 });
  t.after(() => fixture.close());
  const socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const open = () => serve({ ...fixture.settings, port, dataDir: directory }, { models: fixture.models });
  let server = await open();
  try {
    const admin = (await readFile(join(directory, "token"), "utf8")).trim();
    const request = (token: string, path: string, method = "GET", value?: object) => fetch("http://127.0.0.1:" + port + path, {
      method, headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: value === undefined ? undefined : JSON.stringify(value),
    });
    const owner = (path: string, value: object) => request(admin, path, "POST", value);
    const pair = async (deviceId: string) => (await (await owner("/v1/remote/devices", { accountId: "owner", deviceId })).json()).token;
    const phone = await pair("phone"), tablet = await pair("tablet");
    const recipient = { accountId: "owner", deviceId: "phone" };
    const item = await server.runtime.workItems.create({ workspace, title: "Currency", objective: "Check the currency" });
    const run = await server.runtime.workItems.run(item.id, { revision: item.revision, requestId: "currency", confirmed: true });
    const before = await until(() => server.runtime.status(run.id), status => Boolean(status.delegations[0]?.question));
    const path = "/remote/api/work-items/" + item.id + "/runs/" + run.id;
    const permissions = "/v1/work-items/" + item.id;
    const view = async () => (await (await request(phone, path)).json());
    assert.equal((await owner(permissions + "/share-controls", recipient)).status, 409);
    await owner(permissions + "/share", recipient);
    assert.deepEqual((await view()).controls, []);
    assert.deepEqual((await view()).childQuestions, [{ name: "Currency worker", text: "Which currency?" }]);
    const child = before.delegations[0]!;
    const reply = { childId: child.conversationId, questionId: child.question!.id, requestId: "currency-answer", answer: "Use USD." };
    assert.equal((await request(phone, path + "/child-answers", "POST", reply)).status, 403);
    await owner(permissions + "/share-replies", recipient);
    assert.deepEqual((await view()).childQuestions, [{ name: "Currency worker", text: "Which currency?", childId: reply.childId, questionId: reply.questionId }]);
    assert.equal((await request(phone, path + "/control", "POST", { action: "pause", version: "0".repeat(64) })).status, 403);
    assert.equal((await request(phone, permissions + "/share-controls", "POST", recipient)).status, 401);
    assert.equal((await owner(permissions + "/share-controls", recipient)).status, 200);
    const initial = await view();
    assert.deepEqual(initial.controls, ["pause", "cancel"]);
    const pause = { action: "pause", version: initial.controlVersion };
    assert.equal((await request(tablet, path + "/control", "POST", pause)).status, 404);
    assert.equal((await request(phone, path + "/control", "POST", { ...pause, action: "resume" })).status, 400);
    const rival = await Promise.all([request(phone, path + "/control", "POST", pause), request(phone, path + "/control", "POST", pause)]);
    assert.deepEqual(rival.map(response => response.status).sort(), [200, 409]);
    assert.equal((await request(phone, path + "/child-answers", "POST", reply)).status, 409);
    await server.close();
    server = await open();
    const paused = await view();
    assert.equal(paused.status, "paused");
    assert.deepEqual(paused.controls, ["continue", "cancel"]);
    await owner(permissions + "/unshare-controls", recipient);
    assert.equal((await request(phone, path + "/control", "POST", { action: "continue", version: paused.controlVersion })).status, 403);
    await owner(permissions + "/share-controls", recipient);
    assert.equal((await request(phone, path + "/control", "POST", { action: "continue", version: paused.controlVersion })).status, 200);
    const continued = await until(() => server.runtime.status(run.id), status => Boolean(status.delegations[0]?.question));
    assert.equal(continued.deadlineAt, before.deadlineAt);
    assert.deepEqual(continued.budget.tokenLimit, before.budget.tokenLimit);
    assert.deepEqual(continued.budget.costLimit, before.budget.costLimit);
    assert.equal(continued.goal?.epoch, before.goal?.epoch);
    assert.equal(continued.delegations[0]?.conversationId, child.conversationId);
    assert.equal((await request(phone, path + "/control", "POST", pause)).status, 409);
    assert.equal((await request(tablet, path + "/child-answers", "POST", reply)).status, 404);
    assert.equal((await request(phone, path + "/child-answers", "POST", { ...reply, questionId: "999999" })).status, 404);
    await owner(permissions + "/unshare-replies", recipient);
    assert.equal((await request(phone, path + "/child-answers", "POST", reply)).status, 403);
    await owner(permissions + "/share-replies", recipient);
    clearInterval(server.runtime["timer"]);
    assert.equal((await request(phone, path + "/child-answers", "POST", reply)).status, 200);
    await server.close();
    server = await open();
    assert.equal((await request(phone, path + "/child-answers", "POST", reply)).status, 200);
    assert.equal((await request(phone, path + "/child-answers", "POST", { ...reply, answer: "Use EUR." })).status, 409);
    const final = await until(() => server.runtime.status(run.id), status => status.status === "completed");
    assert.equal(answers, 1);
    assert.equal(final.delegations[0]?.answer, "Currency is USD.");
    assert.deepEqual((await view()).controls, []);
    const next = await server.runtime.workItems.run(item.id, { revision: item.revision, requestId: "cancel-currency", confirmed: true });
    await until(() => server.runtime.status(next.id), status => Boolean(status.delegations[0]?.question));
    const nextPath = path.replace(run.id, next.id);
    const nextView = await (await request(phone, nextPath)).json();
    assert.equal((await request(phone, nextPath + "/control", "POST", { action: "cancel", version: nextView.controlVersion })).status, 200);
    const cancelled = await server.runtime.status(next.id);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.activeWorkerCount, 0);
    assert.equal((await request(phone, nextPath + "/control", "POST", { action: "continue", version: nextView.controlVersion })).status, 409);
    await server.runtime.pause(run.id);
    assert.deepEqual((await view()).controls, []);
    assert.equal((await request(phone, path + "/control", "POST", { action: "continue", version: (await view()).controlVersion })).status, 409);
    await owner(permissions + "/unshare", recipient);
    await owner(permissions + "/share", recipient);
    assert.equal((await request(phone, path + "/control", "POST", pause)).status, 403);
    assert.equal((await request(phone, path + "/child-answers", "POST", reply)).status, 403);
  } finally { await server.close(); }
});

test("a project work item persists independently and resolves subdirectories to the same project", async t => {
  const { directory, project, workspace, other } = await directories(t);
  const adapter = {
    task: async () => undefined,
    tasks: async () => [],
    reopen: async () => assert.fail("Editing an item should not reopen a run."),
    start: async () => assert.fail("Opening or editing an item should not start a run."),
  };
  const items = new WorkItems(directory, adapter);
  const item = await items.create({ workspace, title: "  Audit inventory ", objective: "Verify the inventory" });
  assert.equal(item.project, project);
  assert.equal(item.workspace, workspace);
  assert.equal(item.title, "Audit inventory");
  assert.equal(item.revision, 1);
  const reopened = new WorkItems(directory, adapter);
  assert.deepEqual(await reopened.list(project), [item]);
  assert.deepEqual(await reopened.list(workspace), [item]);
  assert.deepEqual(await reopened.list(other), []);
  const edited = await reopened.update(item.id, { revision: 1, objective: "Verify the inventory after editing" });
  assert.equal(edited.id, item.id);
  assert.equal(edited.revision, 2);
  assert.equal(edited.workspace, workspace);
  assert.equal(edited.project, project);
  assert.deepEqual(await reopened.update(item.id, { revision: 2, objective: edited.objective }), edited);
  await assert.rejects(reopened.update(item.id, { revision: 1, title: "Stale edit" }), { status: 409 });
  await assert.rejects(reopened.update(item.id, { revision: 2, workspace: other }), { status: 400 });
  await assert.rejects(reopened.create({ workspace: join(other, "missing"), title: "Missing", objective: "Verify" }), { status: 400 });
});

test("concurrent and historical run retries use one durable task identity and its original revision", async t => {
  const { directory, workspace } = await directories(t);
  const runs = new Map<string, Run>([["legacy", { id: "legacy", objective: "Unrelated", workspace, confirmed: false }]]);
  let starts = 0;
  const reopenedRuns: string[] = [];
  const open = () => new WorkItems<Run>(directory, {
    task: async id => runs.get(id),
    tasks: async () => [...runs.values()],
    reopen: async run => { reopenedRuns.push(run.id); },
    start: async (item, { id, confirmed, workItem }: { id: string; confirmed: boolean; workItem: WorkItemLink }) => {
      starts++;
      const run = { id, confirmed, preparation: !confirmed, workItem, objective: item.objective, workspace: item.workspace };
      runs.set(id, run);
      return run;
    },
  });
  const items = open();
  const first = await items.create({ workspace, title: "Audit", objective: "Verify inventory" });
  const second = await items.create({ workspace, title: "Audit again", objective: "Find inconsistencies" });
  const request = { revision: 1, requestId: "one-attempt" };
  const [original, retry] = await Promise.all([items.run(first.id, request), items.run(first.id, request)]);
  assert.deepEqual(retry, original);
  assert.equal(starts, 1);
  assert.match(original.id, /^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.deepEqual(original.workItem, { id: first.id, revision: 1 });
  assert.equal(original.confirmed, false);
  const reopened = open();
  await reopened.update(first.id, { revision: 1, objective: "Compare against last month's inventory" });
  assert.deepEqual(await reopened.run(first.id, request), original);
  assert.deepEqual(reopenedRuns, [original.id, original.id]);
  await assert.rejects(reopened.run(first.id, { ...request, confirmed: true }), { status: 409 });
  await assert.rejects(reopened.run(first.id, { ...request, requestId: "fresh-but-stale" }), { status: 409 });
  const next = await reopened.run(first.id, { revision: 2, requestId: "second-attempt", confirmed: true });
  const separate = await reopened.run(second.id, request);
  assert.deepEqual((await reopened.runs(first.id)).map(run => run.id), [original.id, next.id]);
  assert.deepEqual(await reopened.runs(second.id), [separate]);
  assert.equal(next.objective, "Compare against last month's inventory");
  assert.equal(next.confirmed, true);
  assert.notEqual(separate.id, original.id);
  assert.equal(starts, 3);
  await assert.rejects(reopened.run(first.id, { revision: 2, requestId: "../bad-key" }), { status: 400 });
});
