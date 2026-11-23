import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { LocalRoutines, nextRoutineTime, type RoutineInput, type RoutineOccurrence } from "../src/routines.js";

const start = Date.parse("2026-11-23T00:00:00Z");
const minute = 60_000;
const first = start + minute;
const iso = (time: number) => new Date(time).toISOString();

for(const missedPolicy of ['run_once','skip'] as const) test(`R03 a live Pi sleeper applies ${missedPolicy} after crossing scheduled slots`,async t=>{
  const dataDir=await tempDir(t),clock=fakeClock(),calls:RoutineOccurrence[]=[];
  const routines=new LocalRoutines({dataDir,...clock,execute:async occurrence=>{calls.push(occurrence);return {status:'notified'};}});
  try {
    await routines.create({id:'suspended',action:'notify',objective:'Synthetic daily reminder',schedule:{kind:'daily',time:'00:01',timeZone:'UTC'},missedPolicy});
    await until(()=>clock.waitingAt(first));
    const latest=start+3*24*60*minute+minute;
    clock.advanceTo(latest+minute);
    await until(async()=>Boolean((await routines.list())[0]?.lastOccurrence));
    assert.equal((await routines.list())[0]!.lastOccurrence!.scheduledAt,iso(latest));
    assert.deepEqual(calls.map(call=>call.scheduledAt),missedPolicy==='run_once' ? [iso(latest)] : []);
  } finally {await routines.close();}
});

function fakeClock() {
  let now = start;
  const pending = new Set<{ at: number; callback: () => void }>();
  return {
    now: () => now,
    setTimer(callback: () => void, delay: number) {
      const timer = { at: now + delay, callback };
      pending.add(timer);
      return () => { pending.delete(timer); };
    },
    advanceTo(at: number) {
      now = at;
      while (true) {
        const due = [...pending].filter((timer) => timer.at <= now).sort((a, b) => a.at - b.at);
        if (!due.length) return;
        for (const timer of due) if (pending.delete(timer)) timer.callback();
      }
    },
    waitingAt(at: number) {
      return [...pending].some((timer) => timer.at === at);
    },
  };
}

async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let checks = 0; checks < 200; checks += 1) {
    if (await predicate()) return;
    await setImmediate();
  }
  assert.fail("The expected Pi timer or receipt did not appear.");
}

async function tempDir(t: TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), "kada-routines-"));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 3 }));
  return dataDir;
}

function reminder(id: string, at: number): RoutineInput {
  return { id, objective: id, action: "notify", schedule: { kind: "once", at: iso(at) } };
}

test("R01 delivers a moved reminder once and leaves a cancelled reminder inactive", async (t) => {
  const dataDir = await tempDir(t);
  const clock = fakeClock();
  const calls: RoutineOccurrence[] = [];
  const routines = new LocalRoutines({
    dataDir, ...clock,
    execute: async (occurrence) => { calls.push(occurrence); return { status: "notified" }; },
  });
  try {
    await routines.create(reminder("move", first));
    await routines.create(reminder("cancel", first));
    await until(() => clock.waitingAt(first));
    assert.equal((await routines.update("move", reminder("move", first + minute))).revision, 2);
    assert.equal((await routines.cancel("cancel")).status, "cancelled");
    await until(() => clock.waitingAt(first + minute));

    clock.advanceTo(first);
    await setImmediate();
    assert.deepEqual(calls, []);
    clock.advanceTo(first + minute);
    await until(async () => (await routines.list()).some((row) => row.id === "move" && row.status === "completed"));

    assert.deepEqual(calls.map((call) => call.id), ["move/2/" + iso(first + minute)]);
    assert.deepEqual((await routines.list()).find((row) => row.id === "move")?.lastOccurrence, {
      id: calls[0].id, scheduledAt: calls[0].scheduledAt, status: "notified",
    });
  } finally {
    await routines.close();
  }
});

async function killFixture(dataDir: string, phase: "sleeping" | "claimed"): Promise<void> {
  const fixture = fileURLToPath(new URL("./fixtures/sleeping-routine.ts", import.meta.url));
  const child = spawn(process.execPath, ["--import", "tsx", fixture, dataDir, String(start), String(first), phase], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = once(child, "exit");
  let output = "";
  let errors = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { errors += chunk; });
  try {
    await Promise.race([
      new Promise<void>((resolve) => {
        child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
          output += chunk;
          if (output.includes(phase + "\n")) resolve();
        });
      }),
      once(AbortSignal.timeout(10_000), "abort").then(() => { throw new Error("Reminder fixture did not become ready."); }),
      exited.then(([code]) => { throw new Error("Reminder fixture exited before sleeping: " + code); }),
    ]);
  } catch (error) {
    throw new Error(String(error) + "\n" + output + "\n" + errors);
  } finally {
    child.kill("SIGKILL");
    await exited;
  }
}

test("R02 reopens a sleeping Pi task after killing the original process", { timeout: 20_000 }, async (t) => {
  const dataDir = await tempDir(t);
  await killFixture(dataDir, "sleeping");
  const clock = fakeClock();
  const calls: RoutineOccurrence[] = [];
  const options = {
    dataDir, ...clock,
    execute: async (occurrence: RoutineOccurrence) => { calls.push(occurrence); return { status: "notified" } as const; },
  };
  let routines = new LocalRoutines(options);
  try {
    await routines.recover();
    await until(() => clock.waitingAt(first));
    clock.advanceTo(first);
    await until(async () => (await routines.list())[0]?.status === "completed");
    await routines.close();
    routines = new LocalRoutines(options);
    await routines.recover();
    assert.equal((await routines.list())[0]?.lastOccurrence?.status, "notified");
    assert.deepEqual(calls.map((call) => call.id), ["restart/1/" + iso(first)]);
  } finally {
    await routines.close();
  }
});

test("R02 replays a claimed occurrence with the same child task ID after SIGKILL", { timeout: 20_000 }, async (t) => {
  const dataDir = await tempDir(t);
  await killFixture(dataDir, "claimed");
  const launchFiles = async () => (await readdir(dataDir)).filter((name) => name.startsWith("task-"));
  const [file] = await launchFiles();
  assert.ok(file);
  const submitted = JSON.parse(await readFile(join(dataDir, file), "utf8")) as Pick<RoutineOccurrence, "id" | "taskId">;
  const clock = fakeClock();
  clock.advanceTo(first + minute);
  const replays: RoutineOccurrence[] = [];
  const routines = new LocalRoutines({
    dataDir, ...clock,
    execute: async (occurrence) => {
      replays.push(occurrence);
      const path = join(dataDir, "task-" + occurrence.taskId + ".json");
      await assert.rejects(writeFile(path, JSON.stringify(occurrence), { flag: "wx" }), { code: "EEXIST" });
      return { taskId: occurrence.taskId };
    },
  });
  try {
    await routines.recover();
    await until(async () => (await routines.list())[0]?.lastOccurrence?.status === "started");
    assert.deepEqual(replays.map(({ id, taskId }) => ({ id, taskId })), [submitted]);
    assert.deepEqual(await launchFiles(), [file]);
    assert.deepEqual((await routines.list())[0]?.lastOccurrence, {
      id: submitted.id, scheduledAt: iso(first), status: "started", taskId: submitted.taskId,
    });
  } finally {
    await routines.close();
  }
});

test("R03 deduplicates submissions and applies budget exhaustion to the active revision", async (t) => {
  const dataDir = await tempDir(t);
  const clock = fakeClock();
  const calls: RoutineOccurrence[] = [];
  const input: RoutineInput = {
    id: "standup", objective: "Prepare standup", action: "task",
    schedule: { kind: "daily", time: "00:01", timeZone: "UTC" },
    budgetPolicy: "pause", notifyOnChange: true,
    budget: { maxEstimatedCostUsd: 0.5, maxDurationMs: 300_000, maxTotalTokens: 500 },
  };
  const routines = new LocalRoutines({
    dataDir, ...clock,
    execute: async (occurrence) => {
      calls.push(occurrence);
      return { taskId: occurrence.taskId };
    },
  });
  try {
    const [created, duplicate] = await Promise.all([routines.create(input), routines.create(input)]);
    assert.deepEqual(created, duplicate);
    assert.equal(created.notifyOnChange, true);
    await assert.rejects(routines.create({ ...input, objective: "Different" }), { status: 409 });
    assert.equal((await routines.update("standup", input)).revision, 1);
    await until(() => clock.waitingAt(first));
    clock.advanceTo(first);
    await until(async () => (await routines.list())[0]?.lastOccurrence?.status === "started");
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].budget, input.budget);
    assert.equal(calls[0].notifyOnChange, true);
    assert.match(calls[0].taskId, /^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);

    await routines.settleBudget(calls[0].id);
    const [paused] = await routines.list();
    assert.equal(paused.status, "paused");
    assert.equal(paused.nextRunAt, undefined);
    assert.equal(paused.lastOccurrence?.status, "budget_exhausted");
    const revised = await routines.update("standup", {
      ...input, schedule: { kind: "daily", time: "00:02", timeZone: "UTC" },
    });
    assert.equal(revised.revision, 2);
    await routines.settleBudget(calls[0].id);
    assert.equal((await routines.list())[0].status, "scheduled");
    await until(() => clock.waitingAt(first + minute));
    clock.advanceTo(first + minute);
    await until(async () => (await routines.list())[0]?.lastOccurrence?.id.startsWith("standup/2/") === true);
    assert.equal(calls.length, 2);
    assert.notEqual(calls[0].taskId, calls[1].taskId);
  } finally {
    await routines.close();
  }
});

test("R03 replays only the latest missed slot and persists a skipped slot", async (t) => {
  const dataDir = await tempDir(t);
  const clock = fakeClock();
  const calls: RoutineOccurrence[] = [];
  const options = {
    dataDir, ...clock,
    execute: async (occurrence: RoutineOccurrence) => { calls.push(occurrence); return { status: "notified" } as const; },
  };
  const input: RoutineInput = {
    objective: "Check the day", action: "notify",
    schedule: { kind: "daily", time: "00:01", timeZone: "UTC" },
  };
  let routines = new LocalRoutines(options);
  try {
    await routines.create({ ...input, id: "run", missedPolicy: "run_once" });
    await routines.create({ ...input, id: "skip", missedPolicy: "skip" });
    await until(() => clock.waitingAt(first));
    await routines.close();
    clock.advanceTo(start + 3 * 86_400_000 + minute * 2);
    routines = new LocalRoutines(options);
    await routines.recover();
    await until(async () => (await routines.list()).every((row) => row.lastOccurrence !== undefined));
    const latest = iso(start + 3 * 86_400_000 + minute);
    assert.deepEqual(calls.map((call) => call.id), ["run/1/" + latest]);
    const skipped = (await routines.list()).find((row) => row.id === "skip");
    assert.deepEqual(skipped?.lastOccurrence, { id: "skip/1/" + latest, scheduledAt: latest, status: "skipped" });
  } finally {
    await routines.close();
  }
});

test("R04 chooses the first valid instant in a gap and the earlier instant in a fold", () => {
  const schedule = { kind: "daily", time: "02:30", timeZone: "America/Los_Angeles" } as const;
  assert.equal(nextRoutineTime(schedule, Date.parse("2026-03-08T08:00:00Z")), Date.parse("2026-03-08T10:00:00Z"));

  const fold = { ...schedule, kind: "weekly", weekday: 0, time: "01:30" } as const;
  const first = Date.parse("2026-11-01T08:30:00Z");
  assert.equal(nextRoutineTime(fold, Date.parse("2026-11-01T07:00:00Z")), first);
  assert.equal(nextRoutineTime(fold, first), Date.parse("2026-11-08T09:30:00Z"));
});
