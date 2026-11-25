import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { WorkItems, type WorkItemLink, type WorkItemRun } from "../src/work-items.js";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { serve } from "../src/server.js";
import { scriptedFixture, until } from "./helpers.js";

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
    const item = { workspace, title: "Audit inventory", objective: "Verify the inventory" };
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
