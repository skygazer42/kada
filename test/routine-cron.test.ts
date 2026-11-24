import assert from "node:assert/strict";
import { createModels } from "@earendil-works/pi-ai";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { latestRoutineTime, nextRoutineTime, normalizeRoutineSchedule } from "../src/routine-schedule.js";
import { LocalRoutines, type Routine, type RoutineOccurrence } from "../src/routines.js";
import { serve } from "../src/server.js";
import { fakeRoutineClock, until } from "./helpers.js";

const cron = (expression: string, timeZone = "UTC") => ({ kind: "cron", expression, timeZone } as const);
const at = Date.parse;

test("cron normalizes five fields and finds calendar dates in the requested timezone", () => {
  const monthEnd = normalizeRoutineSchedule(cron("  0  9\t31 * *  ", "Asia/Kolkata"));
  assert.deepEqual(monthEnd, cron("0 9 31 * *", "Asia/Kolkata"));
  const january = at("2026-01-31T03:30:00Z");
  assert.equal(nextRoutineTime(monthEnd, january), at("2026-03-31T03:30:00Z"));
  assert.equal(latestRoutineTime(monthEnd, january), january);
  assert.equal(latestRoutineTime(monthEnd, january - 1), at("2025-12-31T03:30:00Z"));
  assert.equal(nextRoutineTime(cron("0 9 29 2 *"), at("2025-01-01T00:00:00Z")), at("2028-02-29T09:00:00Z"));
});

test("cron validates expression, timezone, and supported fields", () => {
  for (const expression of ["@monthly", "0 9 * *", "0 0 9 1 * *", "0 0 9 1 * * 2027", "0 9 * * @daily", "*".repeat(300)]) {
    assert.throws(() => normalizeRoutineSchedule(cron(expression)), /five fields/i);
  }
  for (const expression of ["60 9 * * *", "0 24 * * *", "0 9 32 * *", "0 9 * 13 *", "0 9 * * 8", "*/0 * * * *"]) {
    assert.throws(() => normalizeRoutineSchedule(cron(expression)), /invalid cron expression/i);
  }
  for (const zone of ["", "+05:30", "Mars/Olympus"]) {
    assert.throws(() => normalizeRoutineSchedule(cron("0 9 1 * *", zone)), /IANA time zone/i);
  }
  const unknown = { ...cron("0 9 1 * *"), endsAt: "2030-01-01T00:00:00Z" };
  assert.throws(() => normalizeRoutineSchedule(unknown), /only kind, expression and timeZone/i);
});

test("cron resolves spring gaps and fall folds consistently in both directions", () => {
  const zone = "America/New_York";
  const gap = cron("30 2 * * *", zone);
  const transition = at("2026-03-08T07:00:00Z");
  assert.equal(nextRoutineTime(gap, transition - 1), transition);
  assert.equal(latestRoutineTime(gap, transition), transition);
  assert.equal(nextRoutineTime(gap, transition), at("2026-03-09T06:30:00Z"));
  const fold = cron("30 1 * * *", zone);
  const earlier = at("2026-11-01T05:30:00Z");
  assert.equal(nextRoutineTime(fold, earlier - 1), earlier);
  assert.equal(latestRoutineTime(fold, at("2026-11-01T06:05:00Z")), earlier);
  assert.equal(nextRoutineTime(fold, earlier), at("2026-11-02T06:30:00Z"));
  assert.equal(nextRoutineTime(cron("* * * * *", zone), at("2026-11-01T06:05:00Z")), at("2026-11-01T06:06:00Z"));
});

test("cron uses native missed-slot policies across a restart into the second fall hour", async t => {
  const dataDir = await mkdtemp(join(tmpdir(), "kada-cron-"));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 3 }));
  const clock = fakeRoutineClock(at("2026-10-30T00:00:00Z"));
  const calls: RoutineOccurrence[] = [];
  const open = () => new LocalRoutines({ dataDir, ...clock, execute: async (occurrence) => {
    calls.push(occurrence);
    return { status: "notified" };
  } });
  let routines = open();
  try {
    const schedule = cron("30 1 * * *", "America/New_York");
    await assert.rejects(routines.create({ action: "notify", objective: "Impossible calendar date", schedule: cron("0 0 31 2 *") }),
      { status: 400, message: /no future occurrences/i });
    await routines.create({ id: "run", action: "notify", objective: "Run the most recent slot", schedule, missedPolicy: "run_once" });
    await routines.create({ id: "skip", action: "notify", objective: "Skip the most recent slot", schedule });
    await until(async () => clock.waitingAt(at("2026-10-30T05:30:00Z")), Boolean);
    await routines.close();

    clock.advanceTo(at("2026-11-01T06:05:00Z"));
    routines = open();
    await routines.recover();
    const rows = await until(() => routines.list(), rules => rules.every(rule => rule.lastOccurrence !== undefined));
    assert.deepEqual(rows.map(rule => [rule.id, rule.lastOccurrence?.status, rule.lastOccurrence?.scheduledAt, rule.nextRunAt]), [
      ["run", "notified", "2026-11-01T05:30:00.000Z", "2026-11-02T06:30:00.000Z"],
      ["skip", "skipped", "2026-11-01T05:30:00.000Z", "2026-11-02T06:30:00.000Z"],
    ]);
    assert.deepEqual(calls.map(occurrence => occurrence.id), ["run/1/2026-11-01T05:30:00.000Z"]);
  } finally { await routines.close(); }
});

test("the authenticated routine API validates and persists cron schedules", async t => {
  const dataDir = await mkdtemp(join(tmpdir(), "kada-cron-api-"));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 3 }));
  const socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const clock = fakeRoutineClock(at("2026-11-24T00:00:00Z"));
  const server = await serve({ dataDir, port, maxSubagents: 1, maxDurationMs: 1000 }, { models: createModels(), routineClock: clock });
  try {
    const token = (await readFile(join(dataDir, "token"), "utf8")).trim();
    const root = `http://127.0.0.1:${port}/v1/routines`;
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const post = (expression: string) => ({
      method: "POST", body: JSON.stringify({ id: "cron-api", action: "notify", objective: "The monthly report", schedule: cron(expression) }),
    });
    assert.equal((await fetch(root, post("0 9 1 * *"))).status, 401);
    const rejected = await fetch(root, { ...post("0 0 9 1 * *"), headers });
    assert.equal(rejected.status, 400);
    assert.match((await rejected.json() as { error: string }).error, /five fields/i);
    const accepted = await fetch(root, { ...post("0 9 1 * *"), headers });
    assert.equal(accepted.status, 201);
    const view = await accepted.json() as Routine;
    assert.equal(view.nextRunAt, "2026-12-01T09:00:00.000Z");
    assert.deepEqual(await (await fetch(root, { headers })).json(), [view]);
  } finally { await server.close(); }
});
