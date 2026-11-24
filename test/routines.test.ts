import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate, setTimeout } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { LocalRoutines, nextRoutineTime, type RoutineInput, type RoutineOccurrence } from "../src/routines.js";
import {LocalRuntime} from '../src/runtime.js';
import {createModels} from '@earendil-works/pi-ai';
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";
import {mkdir} from 'node:fs/promises';
import {fakeRoutineClock} from './helpers.js';

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

const fakeClock = () => fakeRoutineClock(start);

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

test("R01 the runtime routes the injected clock's due reminder to the inbox", async (t) => {
  const dataDir = await tempDir(t);
  const clock = fakeClock();
  const runtime = new LocalRuntime({ dataDir, port:4317, maxSubagents:1, maxDurationMs:30_000 }, {
    models:createModels(), routineClock:clock,
  });
  try {
    const rule = await runtime.routines.create(reminder("runtime-clock", first));
    await until(() => clock.waitingAt(first));
    assert.deepEqual(await runtime.notifications(), []);
    clock.advanceTo(first);
    await until(async () => (await runtime.routines.history(rule.id)).some(event => event.status === "notified"));
    const notifications = await runtime.notifications();
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0]?.at, first);
    assert.equal(notifications[0]?.routineId, rule.id);
  } finally { await runtime.close(); }
});

async function killFixture(dataDir: string, phase: "sleeping" | "claimed" | "pause" | "cancel" | "update"): Promise<void> {
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

for (const [action, status] of [["pause", "paused"], ["cancel", "cancelled"], ["update", "scheduled"]] as const) {
  test(`R02 restart discards the obsolete native timer after a committed routine ${action}`, { timeout: 25_000 }, async t => {
    const dataDir = await tempDir(t);
    await killFixture(dataDir, action);
    const clock = fakeClock();
    const calls: RoutineOccurrence[] = [];
    const routines = new LocalRoutines({
      dataDir, ...clock,
      execute: async occurrence => { calls.push(occurrence); return { status: "notified" }; },
    });
    try {
      await routines.recover();
      assert.equal((await routines.list())[0]?.status, status);
      if (action === "update") await until(() => clock.waitingAt(first + minute));
      const { harness } = await (routines as unknown as { open(): Promise<{ harness: Harness }> }).open();
      await until(async () => (await harness.inspect(BACKGROUND_CONTEXT)).tasks.length === (action === "update" ? 1 : 0));
      assert.equal(clock.waitingAt(first), false);
      clock.advanceTo(first);
      assert.deepEqual(calls, []);
      if (action === "update") {
        clock.advanceTo(first + minute);
        await until(() => calls.length === 1);
        assert.equal(calls[0]?.revision, 2);
      }
    } finally { await routines.close(); }
  });
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
    const budgetHistory=await routines.history('standup');
    assert.deepEqual(budgetHistory.map(row=>row.status),['claimed','started','budget_exhausted']);
    assert.deepEqual(budgetHistory[0]!.budget,input.budget);
    await routines.settleBudget(calls[0].id);
    assert.deepEqual(await routines.history('standup'),budgetHistory);
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
    assert.deepEqual((await routines.history('skip')).map(row=>[row.id,row.status]),[['skip/1/'+latest,'skipped']]);
  } finally {
    await routines.close();
  }
});

test("a recurring rule checks overlap only within its opted-in revision", async t => {
  const dataDir = await tempDir(t);
  const clock = fakeClock();
  const calls: RoutineOccurrence[] = [];
  let lookups = 0;
  const routines = new LocalRoutines({
    dataDir, ...clock,
    execute: async occurrence => { calls.push(occurrence); return { taskId: occurrence.taskId }; },
    taskOverview: async () => { lookups++; return { status: "blocked", reason: "Waiting on input", question: null, summary: null }; },
  });
  const rule: RoutineInput = {
    id: "overlap-revision", action: "task", objective: "Original recurring rule",
    schedule: { kind: "daily", time: "00:01", timeZone: "UTC" },
  };
  const fire = async (day: number) => {
    const at = first + day * 86_400_000;
    await until(() => clock.waitingAt(at));
    clock.advanceTo(at);
    await until(async () => (await routines.list())[0]?.lastOccurrence?.scheduledAt === iso(at));
  };
  try {
    await routines.create(rule);
    await fire(0);
    await fire(1);
    assert.equal(lookups, 0);
    assert.deepEqual(calls.map(call => call.revision), [1, 1]);
    await routines.update(rule.id!, { ...rule, overlapPolicy: "skip" });
    await fire(2);
    await fire(3);
    assert.equal((await routines.list())[0]?.lastOccurrence?.blockedBy?.taskId, calls[2]?.taskId);
    await routines.update(rule.id!, { ...rule, objective: "Revised recurring rule", overlapPolicy: "skip" });
    await fire(4);
    assert.deepEqual(calls.map(call => call.revision), [1, 1, 2, 3]);
    assert.equal(lookups, 1);
  } finally { await routines.close(); }
});

test("budget settlement can abort a timer waiting for the prior task state", async t => {
  const dataDir = await tempDir(t);
  const clock = fakeClock();
  const lookup = Promise.withResolvers<undefined>();
  let lookingUp = false;
  const routines = new LocalRoutines({
    dataDir, ...clock,
    execute: async occurrence => ({ taskId: occurrence.taskId }),
    taskOverview: () => { lookingUp = true; return lookup.promise; },
  });
  const id = "overlap-budget";
  const timeout = new AbortController();
  let settlement: Promise<void> | undefined;
  try {
    await routines.create({
      id, action: "task", objective: "Budget-limited solution", overlapPolicy: "skip",
      schedule: { kind: "daily", time: "00:01", timeZone: "UTC" },
    });
    await until(() => clock.waitingAt(first));
    clock.advanceTo(first);
    const next = first + 86_400_000;
    await until(() => clock.waitingAt(next));
    const [routine] = await routines.list();
    assert.equal(routine.lastOccurrence?.status, "started");
    const occurrenceId = routine.lastOccurrence!.id;
    clock.advanceTo(next);
    await until(() => lookingUp);

    settlement = routines.settleBudget(occurrenceId);
    const settled = await Promise.race([settlement.then(() => true), setTimeout(2_000, false, { signal: timeout.signal })]);
    assert.equal(settled, true, "Settlement must finish before the pending task state lookup returns.");
    assert.equal((await routines.list())[0].status, "paused");
    assert.deepEqual((await routines.history(id)).map(row => row.status), ["claimed", "started", "budget_exhausted"]);
  } finally {
    timeout.abort();
    lookup.resolve(undefined);
    await settlement;
    await routines.close();
  }
});

test("resuming a recurring budget-paused rule isolates earlier stops from current slots", async t => {
  const dataDir = await tempDir(t);
  const clock = fakeClock();
  const calls: RoutineOccurrence[] = [];
  const rules = new LocalRoutines({
    dataDir, ...clock,
    execute: async occurrence => { calls.push(occurrence); return { taskId: occurrence.taskId }; },
    taskOverview: async () => ({ status: "waiting_user", reason: null, question: null, summary: null }),
  });
  const id = "pause-budget";
  const fire = async (offset: number) => {
    const at = first + offset * 86_400_000;
    await until(() => clock.waitingAt(at));
    clock.advanceTo(at);
    await until(async () => (await rules.list())[0]?.lastOccurrence?.scheduledAt === iso(at));
  };
  try {
    await rules.create({ id, action: "task", objective: "Recurring review", overlapPolicy: "skip", schedule: { kind: "daily", time: "00:01", timeZone: "UTC" } });
    await fire(0);
    await rules.pause(id);
    await rules.resume(id);
    await fire(1);
    assert.equal((await rules.list())[0]?.lastOccurrence?.blockedBy?.taskId, calls[0]?.taskId);
    await rules.settleBudget(calls[0]!.id);
    assert.equal((await rules.list())[0]?.status, "scheduled");
    assert((await rules.history(id)).some(event => event.id === calls[0]!.id && event.status === "budget_exhausted"));

    await rules.update(id, { id, action: "task", objective: "Revised recurring review", schedule: { kind: "daily", time: "00:01", timeZone: "UTC" } });
    await fire(2);
    await rules.settleBudget(calls[1]!.id);
    assert.equal((await rules.list())[0]?.status, "paused");
    assert.equal((await rules.resume(id)).revision, 2);
    await rules.settleBudget(calls[1]!.id);
    await fire(3);
    assert.equal(calls.length, 3);
    await rules.cancel(id);
    await rules.settleBudget(calls[2]!.id);
    assert.equal((await rules.list())[0]?.status, "cancelled");
    await assert.rejects(rules.resume(id), { status: 409 });

    await rules.create(reminder("one-shot", first + 4 * 86_400_000));
    await assert.rejects(rules.pause("one-shot"), { status: 409 });
  } finally { await rules.close(); }
});

test("a quick pause and resume keeps an accepted occurrence linked even before its launch receipt", async t => {
  const dataDir = await tempDir(t);
  const clock = fakeClock();
  const accepted = Promise.withResolvers<RoutineOccurrence>();
  const acknowledge = Promise.withResolvers<void>();
  const rules = new LocalRoutines({
    dataDir, ...clock,
    execute: async occurrence => {
      accepted.resolve(occurrence);
      await acknowledge.promise;
      return { taskId: occurrence.taskId };
    },
    taskOverview: async () => ({ status: "running", reason: null, question: null, summary: null }),
  });
  const id = "pause-admission";
  let pause: Promise<unknown> | undefined;
  try {
    await rules.create({ id, action: "task", objective: "Recurring review", overlapPolicy: "skip", schedule: { kind: "daily", time: "00:01", timeZone: "UTC" } });
    await until(() => clock.waitingAt(first));
    clock.advanceTo(first);
    const firstOccurrence = await accepted.promise;

    pause = rules.pause(id);
    await until(async () => (await rules.list())[0]?.status === "paused");
    await rules.resume(id);
    acknowledge.resolve();
    await pause;

    const next = first + 86_400_000;
    await until(() => clock.waitingAt(next));
    clock.advanceTo(next);
    await until(async () => (await rules.list())[0]?.lastOccurrence?.scheduledAt === iso(next));
    const history = await rules.history(id);
    assert.deepEqual(history.map(row => row.status), ["claimed", "skipped"]);
    assert.equal(history[1]?.blockedBy?.taskId, firstOccurrence.taskId);
  } finally {
    acknowledge.resolve();
    await pause;
    await rules.close();
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

test('R04 routine views and receipts explain a daylight-saving adjustment',async t=>{
  const dataDir=await tempDir(t),clock=fakeClock(),calls:RoutineOccurrence[]=[];
  clock.advanceTo(Date.parse('2026-03-08T08:00:00Z'));
  const routines=new LocalRoutines({dataDir,...clock,execute:async occurrence=>{calls.push(occurrence);return {status:'notified'};}});
  try {
    const spring=await routines.create({id:'spring',action:'notify',objective:'Synthetic DST reminder',schedule:{kind:'daily',time:'02:30',timeZone:'America/Los_Angeles'}});
    assert.equal(spring.nextTiming?.adjustment,'gap_forward');
    assert.equal(spring.nextTiming?.requestedTime,'02:30');
    assert.equal(spring.nextTiming?.localTime,'03:00');
    assert.match(spring.nextTiming?.explanation ?? '',/02:30.*03:00/);
    const due=Date.parse(spring.nextRunAt!);
    await until(()=>clock.waitingAt(due));clock.advanceTo(due);
    await until(async()=>(await routines.list())[0]?.lastOccurrence?.status==='notified');
    assert.equal(calls[0]?.timing?.adjustment,'gap_forward');
    assert.deepEqual((await routines.list())[0]?.lastOccurrence?.timing,calls[0]?.timing);
    await routines.cancel('spring');
    clock.advanceTo(Date.parse('2026-11-01T07:00:00Z'));
    const fall=await routines.create({id:'fall',action:'notify',objective:'Synthetic fold reminder',schedule:{kind:'weekly',weekday:0,time:'01:30',timeZone:'America/Los_Angeles'}});
    assert.equal(fall.nextTiming?.adjustment,'fold_earlier');
    assert.equal(fall.nextRunAt,'2026-11-01T08:30:00.000Z');
    assert.match(fall.nextTiming?.explanation ?? '',/第一次/);
  } finally {await routines.close();}
});

test('R03 occurrence history retains old failures and rule revisions after later runs and restart',async t=>{
  const dataDir=await tempDir(t),clock=fakeClock();let calls=0;
  const options={dataDir,...clock,execute:async()=>{calls++;if(calls===1) throw new Error('Synthetic first failure');return {status:'notified'} as const;}};
  let routines=new LocalRoutines(options);
  try {
    const input={id:'history',action:'notify' as const,objective:'First objective',schedule:{kind:'daily' as const,time:'00:01',timeZone:'UTC'}};
    await routines.create(input);await until(()=>clock.waitingAt(first));clock.advanceTo(first);
    await until(async()=>(await routines.list())[0]?.lastOccurrence?.status==='failed');
    const updated=await routines.update('history',{...input,objective:'Second objective'});
    const next=Date.parse(updated.nextRunAt!);await until(()=>clock.waitingAt(next));clock.advanceTo(next);
    await until(async()=>(await routines.list())[0]?.lastOccurrence?.status==='notified');
    const before=await routines.history('history');
    assert.deepEqual(before.filter(row=>row.status!=='claimed').map(row=>[row.revision,row.objective,row.status]),[[1,'First objective','failed'],[2,'Second objective','notified']]);
    assert(before[1]!.sequence>before[0]!.sequence);
    await routines.close();routines=new LocalRoutines(options);await routines.recover();
    assert.deepEqual(await routines.history('history'),before);
    await routines.cancel('history');assert.deepEqual(await routines.history('history'),before);
    assert.equal(calls,2);await assert.rejects(routines.history('missing'),{status:404});
  } finally {await routines.close();}
});

test('R03 an old occurrence budget event survives rule edits and cancellation without changing the new rule',async t=>{
  const dataDir=await tempDir(t),clock=fakeClock(),calls:RoutineOccurrence[]=[];
  const routines=new LocalRoutines({dataDir,...clock,execute:async occurrence=>{calls.push(occurrence);return {taskId:occurrence.taskId};}});
  try {
    const input:RoutineInput={id:'old-budget',action:'task',objective:'First',schedule:{kind:'daily',time:'00:01',timeZone:'UTC'},budget:{maxEstimatedCostUsd:1,maxDurationMs:1000},budgetPolicy:'pause'};
    await routines.create(input);await until(()=>clock.waitingAt(first));clock.advanceTo(first);await until(async()=>(await routines.list())[0]?.lastOccurrence?.status==='started');
    const revised=await routines.update('old-budget',{...input,objective:'Second'});
    await routines.settleBudget(calls[0]!.id);
    assert((await routines.history('old-budget')).some(row=>row.revision===1 && row.status==='budget_exhausted' && row.objective==='First'));
    assert.equal((await routines.list())[0]!.status,'scheduled');
    const due=Date.parse(revised.nextRunAt!);await until(()=>clock.waitingAt(due));clock.advanceTo(due);await until(()=>calls.length===2);
    await routines.cancel('old-budget');await routines.settleBudget(calls[1]!.id);
    assert((await routines.history('old-budget')).some(row=>row.revision===2 && row.status==='budget_exhausted'));
    assert.equal((await routines.list())[0]!.status,'cancelled');
  } finally {await routines.close();}
});

test('R03 repeated late budget updates retain one event after the latest slot has advanced',async t=>{
  const dataDir=await tempDir(t),clock=fakeClock(),calls:RoutineOccurrence[]=[];
  const routines=new LocalRoutines({dataDir,...clock,execute:async occurrence=>{calls.push(occurrence);return {taskId:occurrence.taskId};}});
  try {
    await routines.create({id:'late-budget',action:'task',objective:'First',schedule:{kind:'daily',time:'00:01',timeZone:'UTC'},budget:{maxEstimatedCostUsd:1,maxDurationMs:1000},budgetPolicy:'skip'});
    for(const at of [first,first+86_400_000]) {await until(()=>clock.waitingAt(at));clock.advanceTo(at);await until(async()=>(await routines.list())[0]?.lastOccurrence?.scheduledAt===iso(at));}
    await routines.settleBudget(calls[0]!.id);await routines.settleBudget(calls[0]!.id);
    assert.equal((await routines.history('late-budget')).filter(row=>row.id===calls[0]!.id && row.status==='budget_exhausted').length,1);
    assert.equal((await routines.list())[0]!.lastOccurrence!.id,calls[1]!.id);
  } finally {await routines.close();}
});

test('R03 cancellation during an unacknowledged action retains its uncertain claim',async t=>{
  const dataDir=await tempDir(t),clock=fakeClock();let entered=false;
  let release!:()=>void;const acknowledgement=new Promise<void>(done=>{release=done;});
  const routines=new LocalRoutines({dataDir,...clock,execute:async()=>{entered=true;await acknowledgement;return {status:'notified'};}});
  try {
    await routines.create(reminder('uncertain',first));await until(()=>clock.waitingAt(first));clock.advanceTo(first);await until(()=>entered);
    const cancelling=routines.cancel('uncertain');await until(async()=>(await routines.list())[0]?.status==='cancelled');release();await cancelling;
    const history=await routines.history('uncertain');
    assert.equal(history.length,1);assert.equal(history[0]!.status,'claimed');
    assert.equal((await routines.list())[0]!.status,'cancelled');
  } finally {release();await routines.close();}
});

test('R03 daemon recovery settles a persisted task budget stop before waking another occurrence',async t=>{
  const dataDir=await tempDir(t),clock=fakeClock(),calls:RoutineOccurrence[]=[];
  const options={dataDir,...clock,execute:async(occurrence:RoutineOccurrence)=>{calls.push(occurrence);return {taskId:occurrence.taskId};}};
  const initial=new LocalRoutines(options);
  await initial.create({id:'recovery-budget',action:'task',objective:'Synthetic recovery',schedule:{kind:'daily',time:'00:01',timeZone:'UTC'},budgetPolicy:'pause',missedPolicy:'run_once',budget:{maxEstimatedCostUsd:1,maxDurationMs:1000}});
  await until(()=>clock.waitingAt(first));clock.advanceTo(first);await until(async()=>(await initial.list())[0]?.lastOccurrence?.status==='started');await initial.close();
  const occurrence=calls[0]!;const taskDir=join(dataDir,'tasks',occurrence.taskId);await mkdir(taskDir,{recursive:true});
  await writeFile(join(taskDir,'task.json'),JSON.stringify({id:occurrence.taskId,objective:occurrence.objective,workspace:join(dataDir,'workspace'),model:{provider:'fixture',modelId:'unused'},createdAt:first,deadlineAt:first+1000,maxSubagents:1,control:'budget_limited',routineOccurrenceId:occurrence.id}));
  clock.advanceTo(first+86_400_000);
  const runtime=new LocalRuntime({dataDir,port:4317,maxSubagents:1,maxDurationMs:1000,discovery:false,web:false},{models:createModels()});
  const restored=new LocalRoutines(options);Object.defineProperty(runtime,'routines',{value:restored});
  try {
    await runtime.recover();
    assert.equal((await restored.list())[0]!.status,'paused');
    assert.equal((await restored.history('recovery-budget')).filter(row=>row.status==='budget_exhausted').length,1);
    assert.equal(calls.length,1);
  } finally {await runtime.close();}
});

test('R03 occurrence history crosses native Pi entry pages without losing identities', {timeout:30000},async t=>{
  const dataDir=await tempDir(t),clock=fakeClock();let calls=0;
  const routines=new LocalRoutines({dataDir,...clock,execute:async()=>{calls++;return {status:'notified'};}});
  try {
    await routines.create({id:'pages',action:'notify',objective:'Synthetic paged history',schedule:{kind:'daily',time:'00:01',timeZone:'UTC'}});
    for(let day=0;day<105;day++) {
      const at=first+day*86_400_000;await until(()=>clock.waitingAt(at));clock.advanceTo(at);
      await until(async()=>(await routines.list())[0]?.lastOccurrence?.scheduledAt===iso(at));
    }
    const history=await routines.history('pages');
    assert.equal(calls,105);assert.equal(history.length,210);
    assert.equal(new Set(history.map(row=>row.sequence)).size,210);
    assert.equal(new Set(history.map(row=>row.id)).size,105);
    assert(history.every((row,index)=>index===0||row.sequence>history[index-1]!.sequence));
    assert.deepEqual(await routines.history('pages'),history);
  } finally {await routines.close();}
});
