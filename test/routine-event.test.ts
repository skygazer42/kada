import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { LocalRoutines, type RoutineInput, type RoutineOccurrence } from "../src/routines.js";
import { fakeRoutineClock, until } from "./helpers.js";

const start = Date.parse("2026-11-23T00:00:00Z");
const first = start + 60_000;
const input = {
  id: "inventory", action: "task", objective: "Summarize the preset inventory",
  schedule: { kind: "daily", time: "00:01", timeZone: "UTC" },
  budget: { maxEstimatedCostUsd: 1, maxDurationMs: 5000, maxTotalTokens: 2000 },
  event: { source: "warehouse", type: "inventory.changed", equals: { region: "east", active: true } },
} satisfies RoutineInput;
const event = {
  source: input.event.source, type: input.event.type, eventId: "delivery-1",
  data: { region: "east", active: true, objective: "Do something outside the rule", command: "an untrusted string" },
};

async function temporaryDirectory(t: TestContext) {
  const path = await mkdtemp(join(tmpdir(), "kada-event-"));
  t.after(() => rm(path, { recursive: true, force: true, maxRetries: 5 }));
  return path;
}

test("a matching event uses the preset routine and replays its original receipt after restart and edits", async t => {
  const dataDir = await temporaryDirectory(t);
  const clock = fakeRoutineClock(start);
  const calls: RoutineOccurrence[] = [];
  const options = { dataDir, ...clock, execute: async (occurrence: RoutineOccurrence) => {
    calls.push(occurrence); return { taskId: occurrence.taskId };
  } };
  let routines = new LocalRoutines(options);
  try {
    await routines.create({ ...input, workspace: dataDir });
    const [accepted, duplicate] = await Promise.all([
      routines.receiveEvent(input.id, event),
      routines.receiveEvent(input.id, { ...event, data: { command: event.data.command, objective: event.data.objective, active: true, region: "east" } }),
    ]);
    assert.equal(accepted.outcome, "accepted");
    assert.deepEqual(duplicate, accepted);
    const receipt = accepted.receipt!;
    assert.equal(receipt.trigger, "event");
    assert.deepEqual(receipt.event, { source: event.source, type: event.type, eventId: event.eventId });
    await until(() => routines.history(input.id), rows => rows.some(row => row.id === receipt.id && row.status === "started"));
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.objective, input.objective);
    assert.equal(calls[0]!.workspace, dataDir);
    assert.deepEqual(calls[0]!.budget, input.budget);
    assert.equal(JSON.stringify(await routines.history(input.id)).includes(event.data.command), false);
    await routines.settleBudget(receipt.id);
    const [calendar] = await routines.list();
    assert.equal(calendar.nextRunAt, new Date(first).toISOString());
    assert.equal(calendar.status, "scheduled");
    assert.equal(calendar.lastOccurrence, undefined);
    assert.equal((await routines.history(input.id)).filter(row => row.id === receipt.id && row.status === "budget_exhausted").length, 1);

    await routines.close();
    routines = new LocalRoutines(options);
    await routines.recover();
    await routines.update(input.id, { ...input, objective: "Changed rule" });
    assert.deepEqual(await routines.receiveEvent(input.id, event), accepted);
    await assert.rejects(routines.receiveEvent(input.id, { ...event, data: { ...event.data, command: "Changed payload" } }), { status: 409 });
    assert.equal(calls.length, 1);
    const manual = await routines.runNow(input.id, event.eventId);
    assert.notEqual(manual.id, receipt.id);
  } finally { await routines.close(); }
});

test("event filtering creates no tasks and stays final when a rule is edited", async t => {
  const dataDir = await temporaryDirectory(t);
  const clock = fakeRoutineClock(start);
  const routines = new LocalRoutines({ dataDir, ...clock, execute: async () => assert.fail("Filtered events must never start a task") });
  try {
    const candidate = { ...event, data: { region: "west", active: true } };
    await routines.create(input);
    assert.deepEqual(await routines.receiveEvent(input.id, { ...candidate, source: "different" }), { outcome: "filtered" });
    assert.deepEqual(await routines.receiveEvent(input.id, { ...candidate, type: "other.type" }), { outcome: "filtered" });
    const filtered = await routines.receiveEvent(input.id, candidate);
    assert.equal(filtered.outcome, "filtered");
    assert.equal(filtered.receipt?.status, "skipped");
    assert.equal(filtered.receipt?.taskId, undefined);
    assert.equal((await routines.history(input.id)).length, 1);
    await routines.update(input.id, { ...input, event: { ...input.event, equals: { region: "west" } } });
    assert.deepEqual(await routines.receiveEvent(input.id, candidate), filtered);
    await assert.rejects(routines.receiveEvent(input.id, event), { status: 409 });
    await routines.pause(input.id);
    await assert.rejects(routines.receiveEvent(input.id, { ...candidate, eventId: "fresh-paused" }), { status: 409 });
    assert.deepEqual(await routines.receiveEvent(input.id, candidate), filtered);
  } finally { await routines.close(); }
});

test("an event-only rule schedules no calendar runs and preserves receipts across pause and reopen", async t => {
  const dataDir = await temporaryDirectory(t);
  const clock = fakeRoutineClock(start);
  const calls: RoutineOccurrence[] = [];
  const options = { dataDir, ...clock, execute: async (occurrence: RoutineOccurrence) => {
    calls.push(occurrence);
    return { taskId: occurrence.taskId };
  } };
  let routines = new LocalRoutines(options);
  try {
    const rule = { ...input, schedule: { kind: "event" as const } };
    await assert.rejects(routines.create({ ...rule, event: undefined }), { status: 400 });
    assert.equal((await routines.create(rule)).nextRunAt, undefined);
    clock.advanceTo(first + 86_400_000);
    assert.deepEqual(await routines.history(rule.id), []);
    const accepted = await routines.receiveEvent(rule.id, event);
    await until(() => routines.history(rule.id), rows => rows.some(row => row.status === "started"));
    await routines.pause(rule.id);
    await routines.close();
    routines = new LocalRoutines(options);
    await routines.recover();
    assert.equal((await routines.list())[0]?.status, "paused");
    assert.deepEqual(await routines.receiveEvent(rule.id, event), accepted);
    await assert.rejects(routines.receiveEvent(rule.id, { ...event, eventId: "during-pause" }), { status: 409 });
    assert.equal((await routines.resume(rule.id)).nextRunAt, undefined);
    await routines.runNow(rule.id, "manual");
    await until(() => routines.history(rule.id), rows => rows.some(row => row.trigger === "manual" && row.status === "started"));
    assert.deepEqual(calls.map(row => row.trigger), ["event", "manual"]);
    const timed = await routines.update(rule.id, { ...rule, schedule: input.schedule });
    assert.notEqual(timed.nextRunAt, undefined);
    const only = await routines.update(rule.id, rule);
    assert.equal(only.nextRunAt, undefined);
    await assert.rejects(routines.receiveEvent(rule.id, { ...event, eventId: "old-revision" }, timed.revision), { status: 409 });
    assert.deepEqual(await routines.receiveEvent(rule.id, event, timed.revision), accepted);
    clock.advanceTo(start + 3 * 86_400_000);
    assert.deepEqual(calls.map(row => row.trigger), ["event", "manual"]);
  } finally { await routines.close(); }
});

test("a budget stop pauses an event-only rule and its saved event can still be replayed", async t => {
  const dataDir = await temporaryDirectory(t);
  const clock = fakeRoutineClock(start);
  const routines = new LocalRoutines({
    dataDir, ...clock,
    execute: async occurrence => ({ taskId: occurrence.taskId }),
  });
  try {
    const rule = { ...input, schedule: { kind: "event" as const } };
    await routines.create(rule);
    const accepted = await routines.receiveEvent(rule.id, event);
    await until(() => routines.history(rule.id), rows => rows.some(row => row.status === "started"));
    await routines.settleBudget(accepted.receipt!.id);
    assert.equal((await routines.list())[0]?.status, "paused");
    assert.deepEqual(await routines.receiveEvent(rule.id, event), accepted);
    await assert.rejects(routines.receiveEvent(rule.id, { ...event, eventId: "fresh" }), { status: 409 });
    await routines.resume(rule.id);
    await routines.settleBudget(accepted.receipt!.id);
    assert.equal((await routines.list())[0]?.status, "scheduled");
  } finally { await routines.close(); }
});

test("event rules and deliveries reject unbounded or non-scalar options", async t => {
  const dataDir = await temporaryDirectory(t);
  const routines = new LocalRoutines({ dataDir, execute: async () => assert.fail("Invalid events must never start a task") });
  try {
    await assert.rejects(routines.create({ ...input, event: { ...input.event, equals: {} } }), { status: 400 });
    await routines.create(input);
    const invalid = [
      { ...event, objective: "attempt to change rule" },
      { ...event, eventId: "/" },
      { ...event, data: { nested: { active: true } } },
      { ...event, data: { list: [true] } },
      { ...event, data: { text: "a".repeat(1025) } },
      { ...event, data: Object.fromEntries(Array.from({ length: 33 }, (_, index) => ["key" + index, index])) },
    ];
    for (const delivery of invalid) await assert.rejects(routines.receiveEvent(input.id, delivery), { status: 400 });
    await routines.create({ ...input, id: "plain", event: undefined });
    await assert.rejects(routines.receiveEvent("plain", event), { status: 409 });
    assert.deepEqual(await routines.history(input.id), []);
  } finally { await routines.close(); }
});
