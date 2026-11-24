import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { LocalRoutines, type RoutineInput, type RoutineOccurrence } from "../src/routines.js";
import { fakeRoutineClock, until } from "./helpers.js";

const start = Date.parse("2026-11-23T00:00:00Z");
const first = start + 60_000;
const day = 86_400_000;
const iso = (at: number) => new Date(at).toISOString();
const input = {
  id: "manual-rule", action: "task", objective: "Check local inventory",
  schedule: { kind: "daily", time: "00:01", timeZone: "UTC" },
} satisfies RoutineInput;

async function folder(t: TestContext) {
  const path = await mkdtemp(join(tmpdir(), "kada-manual-"));
  t.after(() => rm(path, { recursive: true, force: true, maxRetries: 5 }));
  return path;
}

test("manual request retries keep their original occurrence across edits and restart", async t => {
  const dataDir = await folder(t);
  const clock = fakeRoutineClock(start);
  const calls: RoutineOccurrence[] = [];
  const options = {
    dataDir, ...clock,
    execute: async (occurrence: RoutineOccurrence) => { calls.push(occurrence); return { taskId: occurrence.taskId }; },
  };
  let routines = new LocalRoutines(options);
  try {
    await routines.create(input);
    const [accepted, retried] = await Promise.all([routines.runNow(input.id, "retry-key"), routines.runNow(input.id, "retry-key")]);
    assert.deepEqual(retried, accepted);
    assert.equal(accepted.trigger, "manual");
    assert.equal(accepted.status, "claimed");
    await until(() => routines.history(input.id), rows => rows.some(row => row.id === accepted.id && row.status === "started"));
    assert.deepEqual(calls.map(occurrence => occurrence.id), [accepted.id]);
    assert.equal((await routines.list())[0]?.nextRunAt, iso(first));

    await routines.close();
    routines = new LocalRoutines(options);
    await routines.recover();
    await routines.update(input.id, { ...input, objective: "Check new inventory" });
    assert.deepEqual(await routines.runNow(input.id, "retry-key"), accepted);
    const second = await routines.runNow(input.id, "second-key");
    assert.notEqual(second.id, accepted.id);
    assert.notEqual(second.taskId, accepted.taskId);
    assert.equal(second.revision, accepted.revision + 1);
    await until(() => routines.history(input.id), rows => rows.some(row => row.id === second.id && row.status === "started"));

    await until(async () => clock.waitingAt(first), Boolean);
    clock.advanceTo(first);
    await until(() => routines.list(), rules => rules[0]?.lastOccurrence?.status === "started");
    assert.deepEqual(calls.map(occurrence => occurrence.scheduledAt), [iso(start), iso(start), iso(first)]);
    assert.equal((await routines.list())[0]?.nextRunAt, iso(first + day));
  } finally { await routines.close(); }
});

test("manual and scheduled occurrences share overlap and precheck without applying a manual budget stop to the calendar", async t => {
  const dataDir = await folder(t);
  const clock = fakeRoutineClock(start);
  const calls: RoutineOccurrence[] = [];
  let status: "waiting_user" | "budget_limited" = "waiting_user";
  const routines = new LocalRoutines({
    dataDir, ...clock,
    execute: async occurrence => { calls.push(occurrence); return { taskId: occurrence.taskId }; },
    taskOverview: async () => ({ status, reason: null, question: null, summary: null }),
  });
  try {
    await writeFile(join(dataDir, "check.mjs"), "import {appendFileSync} from 'node:fs'; appendFileSync('checks.txt', 'check\\n'); console.log('fixed sample');");
    await routines.create({ ...input, overlapPolicy: "skip", workspace: dataDir, precheck: { command: [process.execPath, "check.mjs"] } });
    const launched = await routines.runNow(input.id, "launch");
    const receipt = async (id: string) => (await routines.history(input.id)).find(row => row.id === id && row.status !== "claimed");
    await until(() => receipt(launched.id), row => row?.status === "started");
    await until(async () => clock.waitingAt(first), Boolean);
    clock.advanceTo(first);
    const [skipped] = await until(() => routines.list(), rules => rules[0]?.lastOccurrence?.status === "skipped");
    assert.equal(skipped.lastOccurrence?.blockedBy?.taskId, launched.taskId);
    const manualBlocked = await routines.runNow(input.id, "blocked");
    const blocked = await until(() => receipt(manualBlocked.id), row => row?.status === "skipped");
    assert.equal(blocked?.blockedBy?.taskId, launched.taskId);
    assert.equal(await readFile(join(dataDir, "checks.txt"), "utf8"), "check\n");

    status = "budget_limited";
    await routines.settleBudget(launched.id);
    await routines.settleBudget(launched.id);
    assert.deepEqual((await routines.list())[0], skipped);
    assert.equal((await routines.history(input.id)).filter(row => row.id === launched.id && row.status === "budget_exhausted").length, 1);

    const sameSample = await routines.runNow(input.id, "same-sample");
    assert.equal((await until(() => receipt(sameSample.id), row => row?.status === "skipped"))?.precheck?.status, "unchanged");
    assert.equal(calls.length, 1);
    assert.equal((await routines.list())[0]?.nextRunAt, iso(first + day));
  } finally { await routines.close(); }
});

test("a concurrent scheduled claim blocks a manual run before task startup", async t => {
  const dataDir = await folder(t);
  const clock = fakeRoutineClock(start);
  const claiming = Promise.withResolvers<RoutineOccurrence>();
  const release = Promise.withResolvers<void>();
  const routines = new LocalRoutines({
    dataDir, ...clock,
    execute: async occurrence => {
      claiming.resolve(occurrence);
      await release.promise;
      return { taskId: occurrence.taskId };
    },
  });
  try {
    await routines.create({ ...input, overlapPolicy: "skip" });
    await until(async () => clock.waitingAt(first), Boolean);
    clock.advanceTo(first);
    const scheduled = await claiming.promise;
    const manual = await routines.runNow(input.id, "same-slot");
    assert.equal(manual.scheduledAt, scheduled.scheduledAt);
    assert.notEqual(manual.taskId, scheduled.taskId);
    const history = await until(() => routines.history(input.id), rows => rows.some(row => row.id === manual.id && row.status === "skipped"));
    assert.deepEqual(history.find(row => row.id === manual.id && row.status === "skipped")?.blockedBy,
      { occurrenceId: scheduled.id, taskId: scheduled.taskId, status: "pending" });
  } finally {
    release.resolve();
    await routines.close();
  }
});

test("an identical pending sample skips a concurrent start but remains eligible after failed admission", async t => {
  const dataDir = await folder(t);
  const clock = fakeRoutineClock(start);
  const firstAdmission = Promise.withResolvers<RoutineOccurrence>();
  const failFirst = Promise.withResolvers<void>();
  const calls: RoutineOccurrence[] = [];
  const routines = new LocalRoutines({
    dataDir, ...clock,
    execute: async occurrence => {
      calls.push(occurrence);
      if (calls.length === 1) {
        firstAdmission.resolve(occurrence);
        await failFirst.promise;
        throw new Error("Synthetic admission failure");
      }
      return { taskId: occurrence.taskId };
    },
  });
  try {
    await routines.create({ ...input, workspace: dataDir, precheck: { command: [process.execPath, "-e", "console.log('same sample')"] } });
    await until(async () => clock.waitingAt(first), Boolean);
    clock.advanceTo(first);
    const scheduled = await firstAdmission.promise;
    const manual = await routines.runNow(input.id, "same-pending-sample");
    const receipt = (id: string) => routines.history(input.id).then(rows => rows.find(row => row.id === id && row.status !== "claimed"));
    const skipped = await until(() => receipt(manual.id), Boolean);
    assert.equal(skipped?.status, "skipped");
    assert.equal(skipped?.precheck?.status, "pending");
    assert.equal(calls.length, 1);
    failFirst.resolve();
    await until(() => receipt(scheduled.id), row => row?.status === "failed");
    const retry = await routines.runNow(input.id, "retry-sample");
    await until(() => receipt(retry.id), row => row?.status === "started");
    assert.equal(calls.length, 2);
  } finally {
    failFirst.resolve();
    await routines.close();
  }
});

test("pausing during manual admission persists an interrupted receipt linked to the possible task", async t => {
  const dataDir = await folder(t);
  const clock = fakeRoutineClock(start);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const routines = new LocalRoutines({
    dataDir, ...clock,
    execute: async occurrence => { entered.resolve(); await release.promise; return { taskId: occurrence.taskId }; },
  });
  try {
    await routines.create(input);
    const accepted = await routines.runNow(input.id, "interrupted");
    await entered.promise;
    const pause = routines.pause(input.id);
    await until(() => routines.list(), rules => rules[0]?.status === "paused");
    release.resolve();
    await pause;
    const history = await routines.history(input.id);
    assert.deepEqual(history.map(row => row.status), ["claimed", "interrupted"]);
    assert.equal(history[1]?.taskId, accepted.taskId);
    assert.match(history[1]?.detail ?? "", /task may already have started/);
    assert.deepEqual(await routines.runNow(input.id, "interrupted"), accepted);
  } finally {
    release.resolve();
    await routines.close();
  }
});

test("budget settlement aborts a reused calendar timer without waiting for queued task admission", async t => {
  const dataDir = await folder(t);
  const clock = fakeRoutineClock(start);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const timeout = new AbortController();
  let settlement: Promise<void> | undefined;
  const routines = new LocalRoutines({
    dataDir, ...clock,
    execute: async occurrence => {
      if (occurrence.scheduledAt !== iso(first)) { entered.resolve(); await release.promise; }
      return { taskId: occurrence.taskId };
    },
  });
  try {
    await routines.create(input);
    await until(async () => clock.waitingAt(first), Boolean);
    clock.advanceTo(first);
    await until(async () => clock.waitingAt(first + day), Boolean);
    const occurrence = (await routines.list())[0]?.lastOccurrence;
    assert.equal(occurrence?.status, "started");
    clock.advanceTo(first + day);
    await entered.promise;
    settlement = routines.settleBudget(occurrence!.id);
    assert(await Promise.race([settlement.then(() => true), setTimeout(2_000, false, { signal: timeout.signal })]));
    assert.equal((await routines.list())[0]?.status, "paused");
  } finally {
    timeout.abort();
    release.resolve();
    await settlement;
    await routines.close();
  }
});

test("a failed overlap lookup records a failed run and releases its admission slot", async t => {
  const dataDir = await folder(t);
  const clock = fakeRoutineClock(start);
  let unavailable = true;
  const routines = new LocalRoutines({
    dataDir, ...clock,
    execute: async occurrence => ({ taskId: occurrence.taskId }),
    taskOverview: async () => {
      if (unavailable) throw new Error("Synthetic lookup failure");
      return { status: "completed", reason: null, question: null, summary: null };
    },
  });
  try {
    await routines.create({ ...input, overlapPolicy: "skip" });
    const outcome = (id: string) => routines.history(input.id).then(rows => rows.find(row => row.id === id && row.status !== "claimed"));
    const started = await routines.runNow(input.id, "first");
    await until(() => outcome(started.id), row => row?.status === "started");
    const failed = await routines.runNow(input.id, "lookup-failure");
    const recorded = await until(async () => await outcome(failed.id) ?? null, Boolean, 2000);
    assert.equal(recorded?.status, "failed");
    assert.match(recorded?.detail ?? "", /prior task status/);
    assert.equal((await routines.list())[0]?.nextRunAt, iso(first));
    unavailable = false;
    const retry = await routines.runNow(input.id, "after-lookup-repair");
    await until(() => outcome(retry.id), row => row?.status === "started");
  } finally { await routines.close(); }
});
