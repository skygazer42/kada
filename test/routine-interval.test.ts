import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { latestRoutineTime, nextRoutineTime, normalizeRoutineSchedule } from "../src/routine-schedule.js";
import { LocalRoutines, type RoutineOccurrence } from "../src/routines.js";
import { fakeRoutineClock, until } from "./helpers.js";

const minute = 60_000;
const anchorAt = "2026-11-23T14:00:00Z";
const anchor = Date.parse(anchorAt);
const interval = { kind: "interval", anchorAt, everyMinutes: 20 } as const;

test("intervals align to a persisted anchor and stop at the inclusive end", () => {
  const schedule = normalizeRoutineSchedule({ ...interval, endsAt: "2026-11-23T14:40:00Z" });
  assert.equal(nextRoutineTime(schedule, anchor - 1), anchor);
  assert.equal(nextRoutineTime(schedule, anchor + 7 * minute), anchor + 20 * minute);
  assert.equal(latestRoutineTime(schedule, anchor - 1), undefined);
  assert.equal(latestRoutineTime(schedule, anchor + 50 * minute), anchor + 40 * minute);
  assert.equal(nextRoutineTime(schedule, anchor + 40 * minute), undefined);
});

test("interval windows and weekdays use the explicit zone across daylight-saving changes", () => {
  const sunday = normalizeRoutineSchedule({
    kind: "interval", anchorAt: "2026-02-28T00:00:00Z", everyMinutes: 20,
    timeZone: "America/New_York", weekdays: [0], window: { start: "02:00", end: "03:00" },
  });
  const prior = Date.parse("2026-03-01T07:40:00Z");
  const afterGap = Date.parse("2026-03-15T06:00:00Z");
  assert.equal(nextRoutineTime(sunday, prior), afterGap);
  assert.equal(latestRoutineTime(sunday, afterGap - 1), prior);

  const fold = normalizeRoutineSchedule({ ...sunday, window: { start: "01:00", end: "01:40" } });
  assert.equal(nextRoutineTime(fold, Date.parse("2026-11-01T05:20:00Z")), Date.parse("2026-11-01T06:00:00Z"));
});

test("invalid interval times, bounds, weekdays and incomplete window zones are rejected", () => {
  const invalid = [
    { ...interval, everyMinutes: 0 }, { ...interval, everyMinutes: 5.5 },
    { ...interval, everyMinutes: Number.MAX_SAFE_INTEGER },
    { ...interval, anchorAt: "2026-11-23T14:00:00" },
    { ...interval, endsAt: "2026-11-22T14:00:00Z" },
    { ...interval, timeZone: "America/New_York", weekdays: [7] },
    { ...interval, timeZone: "America/New_York", weekdays: [1, 1] },
    { ...interval, window: { start: "09:00", end: "09:20" } },
    { ...interval, timeZone: "America/New_York", window: { start: "09:00", end: "09:10" } },
  ];
  for (const schedule of invalid) assert.throws(() => normalizeRoutineSchedule(schedule));
});

test("a bounded interval uses the existing Pi missed-slot policy across restart", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "kada-interval-"));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 3 }));
  const clock = fakeRoutineClock(anchor - minute);
  const calls: RoutineOccurrence[] = [];
  const open = () => new LocalRoutines({ dataDir, ...clock, execute: async (occurrence) => {
    calls.push(occurrence);
    return { status: "notified" };
  } });
  const endsAt = "2026-11-23T14:40:00Z";
  let routines = open();
  try {
    await routines.create({
      id: "every-twenty", objective: "Interval reminder", action: "notify", missedPolicy: "run_once",
      schedule: { ...interval, endsAt },
    });
    await until(async () => clock.waitingAt(anchor), Boolean);
    await routines.close();
    clock.advanceTo(anchor + 50 * minute);
    routines = open();
    await routines.recover();
    await until(() => routines.history("every-twenty"), rows => rows.some(row => row.status === "notified"));
    assert.deepEqual(calls.map(({ scheduledAt }) => scheduledAt), [new Date(endsAt).toISOString()]);
    assert.equal((await routines.list())[0]?.status, "completed");
    await assert.rejects(routines.create({
      id: "expired", objective: "Expired", action: "notify", schedule: { ...interval, endsAt },
    }), /no future occurrences/i);
    const now = new Date(clock.now()).toISOString();
    await routines.create({
      id: "now-only", objective: "The inclusive anchor", action: "notify",
      schedule: { ...interval, anchorAt: now, endsAt: now },
    });
    await until(() => routines.history("now-only"), rows => rows.some(row => row.status === "notified"));
    assert.equal(calls.at(-1)?.scheduledAt, now);
  } finally { await routines.close(); }
});
