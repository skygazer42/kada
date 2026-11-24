import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { fakeRoutineClock, recoveryTestTimeoutMs, scriptedFixture, startRecoveryWorker, until } from "./helpers.js";
import { serve } from "../src/server.js";
import { createClient } from "../src/client.js";
import type { Routine, RoutineHistoryRecord } from "../src/routines.js";

const budget = { maxEstimatedCostUsd: 1, maxDurationMs: 10_000, maxTotalTokens: 10_000 };

test("recurring overlap skips before precheck and links the blocking task across a daemon restart", async () => {
  const first = Date.UTC(2026, 10, 23, 12);
  const day = 86_400_000;
  const clock = fakeRoutineClock(first - 60_000);
  let release!: () => void;
  const running = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const fixture = await scriptedFixture(async () => {
    if (++calls === 1) {
      await running;
      return fauxAssistantMessage(fauxToolCall("task_blocked", {
        reason: "Missing inventory", question: "Which inventory should I use?",
      }), { stopReason: "toolUse" });
    }
    return fauxAssistantMessage(fauxToolCall("task_submit", { summary: "Checked inventory", artifacts: [] }), { stopReason: "toolUse" });
  });
  const socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const settings = { ...fixture.settings, port };
  const client = createClient(settings);
  const options = { models: fixture.models, routineClock: clock };
  let server = await serve(settings, options);
  try {
    const { workspace } = fixture;
    const samples = join(workspace, "samples.txt");
    await writeFile(join(workspace, "sample.mjs"), [
      "import { appendFileSync, readFileSync } from 'node:fs';",
      "appendFileSync('samples.txt', 'sample\\n');",
      "process.stdout.write(readFileSync('samples.txt'));",
    ].join("\n"));
    const rule = {
      id: "overlap", action: "task", objective: "Summarize inventory", workspace, budget,
      overlapPolicy: "skip", precheck: { command: [process.execPath, "sample.mjs"] },
      schedule: { kind: "daily", time: "12:00", timeZone: "UTC" },
    };
    await client.request("/v1/routines", "POST", rule);
    const path = `/v1/routines/${rule.id}/occurrences`;
    const history = (detail = false) => client.request<RoutineHistoryRecord[]>(
      path + (detail ? "?includeTaskStatus=true" : ""),
    );
    const slot = async (offset: number) => {
      const at = first + offset * day;
      await until(async () => clock.waitingAt(at), Boolean);
      clock.advanceTo(at);
      const date = new Date(at).toISOString();
      const rows = await until(() => history(), records => records.some(row => row.scheduledAt === date && row.status !== "claimed"));
      return rows.filter(row => row.scheduledAt === date);
    };

    const [, started] = await slot(0);
    assert.equal(started.status, "started");
    const taskId = started.taskId!;
    await until(async () => calls, count => count === 1);
    assert.equal((await history(true)).find(row => row.status === "started")?.taskStatus, "running");
    const [skippedRunning, ...otherRunning] = await slot(1);
    assert.deepEqual(otherRunning, []);
    assert.equal(skippedRunning.status, "skipped");
    assert.deepEqual(skippedRunning.blockedBy, { occurrenceId: started.id, taskId, status: "running" });
    release();
    await until(() => server.runtime.taskOverview(taskId), overview => overview.status === "waiting_user");

    await server.close();
    server = await serve(settings, options);
    const [skippedWaiting, ...otherWaiting] = await slot(2);
    assert.deepEqual(otherWaiting, []);
    assert.equal(skippedWaiting.status, "skipped");
    assert.deepEqual(skippedWaiting.blockedBy, { occurrenceId: started.id, taskId, status: "waiting_user" });
    assert.equal(skippedWaiting.precheck, undefined);
    assert.equal(await readFile(samples, "utf8"), "sample\n");
    assert.equal(calls, 1);
    assert((await history()).every(row => row.taskStatus === undefined));
    const waiting = (await history(true)).find(row => row.id === started.id && row.status === "started");
    assert.equal(waiting?.taskStatus, "waiting_user");
    assert.equal(waiting?.taskReason, "Missing inventory");
    assert.equal(waiting?.taskQuestion, "Which inventory should I use?");
    assert.equal((await fetch(`http://127.0.0.1:${port}${path}?includeTaskStatus=true`)).status, 401);

    await client.request(`/v1/tasks/${taskId}/messages`, "POST", { message: "Use the main inventory." });
    await until(() => server.runtime.taskOverview(taskId), overview => overview.status === "completed");
    const [, next] = await slot(3);
    assert.equal(next.status, "started");
    assert.notEqual(next.taskId, taskId);
    const delivered = (await history(true)).find(row => row.id === started.id && row.status === "started");
    assert.equal(delivered?.taskStatus, "completed");
    assert.equal(delivered?.taskSummary, "Checked inventory");

    const pausePath = `/v1/routines/${rule.id}/pause`;
    const resumePath = `/v1/routines/${rule.id}/resume`;
    assert.equal((await fetch(`http://127.0.0.1:${port}${pausePath}`, { method: "POST" })).status, 401);
    await until(() => server.runtime.taskOverview(next.taskId!), overview => overview.status === "completed");
    const paused = await client.request<Routine>(pausePath, "POST");
    assert.equal(paused.status, "paused");
    assert.equal(paused.nextRunAt, undefined);
    assert.equal((await server.runtime.taskOverview(next.taskId!)).status, "completed");
    assert.deepEqual(await client.request<Routine>(pausePath, "POST"), paused);
    await server.close();
    clock.advanceTo(first + 5 * day);
    server = await serve(settings, options);
    const [stored] = await client.request<Routine[]>("/v1/routines");
    assert.deepEqual(stored, paused);
    const resumed = await client.request<Routine>(resumePath, "POST");
    assert.equal(resumed.revision, paused.revision);
    assert.equal(resumed.nextRunAt, new Date(first + 6 * day).toISOString());
    assert.deepEqual(await client.request<Routine>(resumePath, "POST"), resumed);
    assert.equal((await history()).some(row => [4, 5].some(dayOffset => row.scheduledAt === new Date(first + dayOffset * day).toISOString())), false);
    const [, resumedSlot] = await slot(6);
    assert.equal(resumedSlot.status, "started");
  } finally {
    release();
    await server.close();
    await fixture.close();
  }
});

test("R03 a fixed precheck only starts a task on the first successful sample or a change", async () => {
  const first = Date.UTC(2026, 10, 23, 12);
  const day = 86_400_000;
  const clock = fakeRoutineClock(first - 60_000);
  let modelCalls = 0;
  const fixture = await scriptedFixture(() => {
    modelCalls++;
    return fauxAssistantMessage(fauxToolCall("task_submit", { summary: "Checked inventory", artifacts: [] }), { stopReason: "toolUse" });
  }, {}, () => [], { routineClock: clock });
  const { runtime, workspace } = fixture;
  try {
    await writeFile(join(workspace, "precheck.mjs"), [
      "import { readFileSync } from 'node:fs';",
      "const input = readFileSync('inventory.txt', 'utf8');",
      "if (input === 'fail') process.exit(7);",
      "process.stdout.write(input);",
    ].join("\n"));
    const rule = await runtime.routines.create({
      workspace, action: "task", objective: "Summarize inventory", budget,
      schedule: { kind: "daily", time: "12:00", timeZone: "UTC" },
      precheck: { command: [process.execPath, "precheck.mjs"] },
    });
    async function run(slot: number, input: string, expected: number) {
      const at = first + slot * day;
      await writeFile(join(workspace, "inventory.txt"), input);
      await until(async () => clock.waitingAt(at), Boolean);
      clock.advanceTo(at);
      const history = await until(() => runtime.routines.history(rule.id), rows =>
        rows.some(row => row.scheduledAt === new Date(at).toISOString() && row.status !== "claimed"));
      const receipt = history.find(row => row.scheduledAt === new Date(at).toISOString() && row.status !== "claimed")!;
      if (receipt.taskId) await until(() => runtime.status(receipt.taskId!), status => status.status === "completed");
      assert.equal(modelCalls, expected);
      return receipt;
    }
    const initial = await run(0, "alpha", 1);
    const unchanged = await run(1, "alpha", 1);
    const failed = await run(2, "fail", 1);
    assert.equal((await run(3, "alpha", 1)).status, "skipped");
    const changed = await run(4, "alpha\nbeta", 2);
    assert.deepEqual([initial.status, unchanged.status, failed.status, changed.status], ["started", "skipped", "failed", "started"]);
    assert.deepEqual([initial.precheck?.status, unchanged.precheck?.status, failed.precheck?.status, changed.precheck?.status],
      ["changed", "unchanged", "failed", "changed"]);
    assert(initial.precheck?.status === "changed" && unchanged.precheck?.status === "unchanged" && changed.precheck?.status === "changed");
    assert.match(initial.precheck.sha256, /^[a-f0-9]{64}$/);
    assert.equal(unchanged.precheck.sha256, initial.precheck.sha256);
    assert.notEqual(changed.precheck.sha256, initial.precheck.sha256);
    const details = await runtime.routines.history(rule.id, true);
    assert.equal(details.find(row => row.id === failed.id && row.status === "claimed")?.taskStatus, "missing");
    assert.equal(details.find(row => row.id === failed.id && row.status === "failed")?.taskStatus, undefined);
    await runtime.routines.pause(rule.id);
    clock.advanceTo(first + 5 * day);
    await runtime.routines.resume(rule.id);
    assert.equal((await run(6, "alpha\nbeta", 2)).precheck?.status, "unchanged");
  } finally { await fixture.close(); }
});

for (const [scenario, expectedTool] of [["routine", "bash"], ["verification", "task_verify"]] as const) test(`SIGKILL after a ${scenario} effect recovers the same task and reads the effect once`, { timeout: recoveryTestTimeoutMs }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "kada-routine-effect-")));
  const fixture = new URL("./fixtures/routine-effect-worker.ts", import.meta.url);
  const labelLog = join(directory, "workspace", "labels.txt");
  let worker = startRecoveryWorker(fixture, "create", directory, scenario);
  try {
    await worker.ready();
    assert.equal(await worker.stop(), "SIGKILL");
    assert.equal(await readFile(labelLog, "utf8"), "label-1\n");

    worker = startRecoveryWorker(fixture, "recover", directory, scenario);
    const recovered = await worker.complete();
    assert.equal(recovered.type, "completed");
    assert.equal(recovered.tasks.length, 1);
    const [taskId] = recovered.tasks;
    assert.deepEqual(recovered.history, scenario === "routine" ? [["claimed", taskId], ["started", taskId]] : []);
    const preparation = scenario === "verification" ? [["task_prepare", false]] : [];
    assert.deepEqual(recovered.tools, [...preparation, [expectedTool, true], ["read", false], ["task_submit", false]]);
    assert.equal(await readFile(labelLog, "utf8"), "label-1\n");
  } finally {
    await worker.stop();
    await rm(directory, { recursive: true, force: true, maxRetries: 5 });
  }
});

test("only changed artifacts notify across separate routine workspaces", async () => {
  let content = "same";
  const fixture = await scriptedFixture((context) => {
    if (!context.messages.some((message) => message.role === "toolResult" && message.toolName === "write")) {
      return fauxAssistantMessage(fauxToolCall("write", { path: "summary.txt", content }), { stopReason: "toolUse" });
    }
    return fauxAssistantMessage(fauxToolCall("task_submit", {
      summary: "Project summary",
      artifacts: ["summary.txt"],
    }), { stopReason: "toolUse" });
  });
  const { runtime } = fixture;
  async function run(slot: number) {
    const task = await runtime.create("Write the project summary", undefined, [], {
      routineOccurrenceId: "auto-workspace/1/" + new Date(Date.UTC(2026, 10, 23, slot)).toISOString(),
      notifyOnChange: true,
      budget,
    });
    await until(() => runtime.status(task.id), (status) => status.status === "completed");
    return task;
  }
  const completionCount = async () => (await runtime.notifications()).filter((item) => item.event === "completed").length;
  try {
    const first = await run(1);
    assert.equal(await completionCount(), 1);
    const second = await run(2);
    assert.notEqual(first.workspace, second.workspace);
    assert.equal(await completionCount(), 1);

    content = "changed";
    await run(3);
    assert.equal(await completionCount(), 2);
  } finally {
    await fixture.close();
  }
});

test("cancelling a claimed routine discards its queued task admission", { timeout: 30_000 }, async () => {
  let modelCalls = 0;
  const fixture = await scriptedFixture(() => {
    modelCalls += 1;
    return fauxAssistantMessage("This task should never reach the model.");
  });
  const { runtime } = fixture;
  const create = runtime.create.bind(runtime);
  const queue = (runtime as unknown as { changes: { run<T>(change: () => Promise<T>): Promise<T> } }).changes;
  let unblock!: () => void;
  const blocked = new Promise<void>((resolve) => { unblock = resolve; });
  const ahead = queue.run(() => blocked);
  let admission: ReturnType<typeof runtime.create> | undefined;
  runtime.create = (...args) => {
    admission = create(...args);
    void admission.catch(() => {});
    return admission;
  };

  try {
    const rule = await runtime.routines.create({
      action: "task",
      objective: "An occurrence cancelled while waiting for admission",
      schedule: { kind: "once", at: new Date(Date.now() + 200).toISOString() },
      budget,
    });
    const queued = await until(async () => ({ admission }), (value) => Boolean(value.admission));
    const cancelling = runtime.routines.cancel(rule.id);
    void cancelling.catch(() => {});
    await until(() => runtime.routines.list(), (rules) =>
      rules.some((item) => item.id === rule.id && item.status === "cancelled"));
    unblock();
    await ahead;
    await cancelling;

    await assert.rejects(queued.admission!);
    assert.equal((await runtime.routines.list())[0]?.status, "cancelled");
    assert.deepEqual(await runtime.list(), []);
    assert.equal(modelCalls, 0);
  } finally {
    unblock();
    await ahead;
    runtime.create = create;
    await fixture.close();
  }
});
