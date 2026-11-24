import { Cron } from "croner";

type CronSchedule = { kind: "cron"; expression: string; timeZone: string };

type IntervalSchedule = {
  kind: "interval";
  anchorAt: string;
  everyMinutes: number;
  endsAt?: string;
  timeZone?: string;
  weekdays?: number[];
  window?: { start: string; end: string };
};

export type RoutineSchedule =
  | { kind: "once"; at: string }
  | { kind: "daily"; time: string; timeZone: string }
  | { kind: "weekly"; weekday: number; time: string; timeZone: string }
  | IntervalSchedule
  | CronSchedule;

const dayMs = 86_400_000;
const minuteMs = 60_000;
const wallTimePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function explicitInstant(value: string, label: string): number {
  const at = typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(at) || !/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/.test(value)) {
    throw new Error(`${label} must have an ISO datetime with an explicit offset.`);
  }
  const day = value.slice(0, 10);
  if (new Date(day + "T00:00:00Z").toISOString().slice(0, 10) !== day) {
    throw new Error(`${label} must have a valid calendar date.`);
  }
  return at;
}

function recurringZone(timeZone: string): string {
  if (typeof timeZone !== "string" || !timeZone || /^[+-]/.test(timeZone)) {
    throw new Error("A recurring routine must have an IANA time zone.");
  }
  return wallClock(timeZone).resolvedOptions().timeZone;
}

function clockMinutes(value: string): number {
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
}

function cronCalendar({ expression, timeZone }: CronSchedule): Cron {
  return new Cron(expression, { mode: "5-part", timezone: timeZone, paused: true });
}

function normalizeCron(schedule: CronSchedule): CronSchedule {
  if (Object.keys(schedule).some(key => !["kind", "expression", "timeZone"].includes(key))) {
    throw new Error("A cron schedule accepts only kind, expression and timeZone.");
  }
  const expression = typeof schedule.expression === "string" ? schedule.expression.trim().replace(/\s+/g, " ") : "";
  if (expression.length > 256 || expression.split(" ").length !== 5 || expression.includes("@")) {
    throw new Error("A cron expression must have five fields: minute, hour, day of month, month, and weekday.");
  }
  const timeZone = typeof schedule.timeZone === "string" ? schedule.timeZone.trim() : "";
  if (timeZone.length > 128 || !/^(?:UTC|[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)+)$/.test(timeZone)) {
    throw new Error("A cron schedule needs a valid IANA time zone.");
  }
  try { recurringZone(timeZone); }
  catch { throw new Error("A cron schedule needs a valid IANA time zone."); }
  const normalized = { kind: "cron" as const, expression, timeZone };
  try { cronCalendar(normalized); }
  catch (error) { throw new Error("Invalid cron expression.", { cause: error }); }
  return normalized;
}

function normalizeInterval(schedule: IntervalSchedule): IntervalSchedule {
  const { everyMinutes, weekdays, window } = schedule;
  if (!Number.isInteger(everyMinutes) || everyMinutes < 5 || everyMinutes > 1440) {
    throw new Error("An interval must be a whole number of minutes from 5 to 1440.");
  }
  const anchor = explicitInstant(schedule.anchorAt, "An interval start");
  const end = schedule.endsAt === undefined ? undefined : explicitInstant(schedule.endsAt, "An interval end");
  if (end !== undefined && end < anchor) throw new Error("An interval end must be at or after its start.");
  const timeZone = schedule.timeZone === undefined ? undefined : recurringZone(schedule.timeZone);
  if (!timeZone && (weekdays !== undefined || window !== undefined)) {
    throw new Error("An interval with weekdays or a time window needs an IANA time zone.");
  }
  if (weekdays !== undefined && (!Array.isArray(weekdays) || !weekdays.length || new Set(weekdays).size !== weekdays.length ||
      weekdays.some(day => !Number.isInteger(day) || day < 0 || day > 6))) {
    throw new Error("Choose distinct interval weekdays from 0 (Sunday) to 6 (Saturday).");
  }
  if (window !== undefined && (!window || typeof window.start !== "string" || typeof window.end !== "string" ||
      !wallTimePattern.test(window.start) || !wallTimePattern.test(window.end) ||
      clockMinutes(window.end) - clockMinutes(window.start) < everyMinutes)) {
    throw new Error("An interval window must use HH:MM and last at least one interval within the same day.");
  }
  return {
    kind: "interval", anchorAt: new Date(anchor).toISOString(), everyMinutes,
    ...(end === undefined ? {} : { endsAt: new Date(end).toISOString() }),
    ...(timeZone ? { timeZone } : {}),
    ...(weekdays ? { weekdays: [...weekdays].sort((a, b) => a - b) } : {}),
    ...(window ? { window: { start: window.start, end: window.end } } : {}),
  };
}

export function normalizeRoutineSchedule(schedule: RoutineSchedule): RoutineSchedule {
  if (!schedule || typeof schedule !== "object") throw new Error("A routine schedule is required.");
  if (schedule.kind === "once") {
    return { kind: "once", at: new Date(explicitInstant(schedule.at, "A reminder")).toISOString() };
  }
  if (schedule.kind === "interval") return normalizeInterval(schedule);
  if (schedule.kind === "cron") return normalizeCron(schedule);
  if (schedule.kind !== "daily" && schedule.kind !== "weekly") {
    throw new Error("A routine schedule must be once, daily, weekly, interval, or cron.");
  }
  if (typeof schedule.time !== "string" || !wallTimePattern.test(schedule.time)) {
    throw new Error("A recurring routine must have a local time in HH:MM format.");
  }
  const timeZone = recurringZone(schedule.timeZone);
  if (schedule.kind === "weekly") {
    if (!Number.isInteger(schedule.weekday) || schedule.weekday < 0 || schedule.weekday > 6) {
      throw new Error("A weekly routine must have a weekday from 0 (Sunday) to 6 (Saturday).");
    }
    return { kind: "weekly", weekday: schedule.weekday, time: schedule.time, timeZone };
  }
  return { kind: "daily", time: schedule.time, timeZone };
}

function wallClock(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en", {
    timeZone,
    calendar: "iso8601",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
}

function wallTime(clock: Intl.DateTimeFormat, at: number): number {
  const parts = clock.formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((field) => field.type === type)!.value);
  return Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second"));
}

function nearbyInstants(clock: Intl.DateTimeFormat, wall: number): number[] {
  return [...new Set([wall - dayMs, wall, wall + dayMs]
    .map((at) => wall - (wallTime(clock, at) - at))
    .sort((a, b) => a - b))];
}

function instantAt(clock: Intl.DateTimeFormat, wall: number): number {
  const instants=nearbyInstants(clock,wall);
  const exact = instants.find((at) => wallTime(clock, at) === wall);
  if (exact !== undefined) return exact;

  // A spring gap brackets the offset transition. Find its first valid instant.
  let low = instants[0]!;
  let high = instants.at(-1)!;
  while (high - low > 1_000) {
    const mid = Math.floor((low + high) / 2_000) * 1_000;
    if (wallTime(clock, mid) < wall) low = mid;
    else high = mid;
  }
  return high;
}

function recurringTime(
  schedule: Extract<RoutineSchedule, { kind: "daily" | "weekly" }>,
  boundary: number,
  direction: 1 | -1,
): number {
  const clock = wallClock(schedule.timeZone);
  const local = new Date(wallTime(clock, boundary));
  const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  const days = schedule.kind === "weekly"
    ? ((schedule.weekday - local.getUTCDay()) * direction + 7) % 7
    : 0;
  const wall = midnight + direction * days * dayMs + clockMinutes(schedule.time) * minuteMs;
  const instant = instantAt(clock, wall);
  if (direction === 1 ? instant > boundary : instant <= boundary) return instant;
  const interval = schedule.kind === "weekly" ? 7 : 1;
  return instantAt(clock, wall + direction * interval * dayMs);
}

function intervalTime(schedule: IntervalSchedule, boundary: number, direction: 1 | -1): number | undefined {
  const anchor = Date.parse(schedule.anchorAt);
  const end = schedule.endsAt === undefined ? 8_640_000_000_000_000 : Date.parse(schedule.endsAt);
  const intervalMs = schedule.everyMinutes * minuteMs;
  const offset = direction === 1
    ? Math.max(0, Math.floor((boundary - anchor) / intervalMs) + 1)
    : Math.floor((Math.min(boundary, end) - anchor) / intervalMs);
  let candidate = anchor + offset * intervalMs;
  const { weekdays, window } = schedule;
  if (candidate < anchor || candidate > end) return;
  if (!weekdays && !window) return candidate;

  const clock = wallClock(schedule.timeZone!);
  const start = window ? clockMinutes(window.start) : 0;
  const stop = window ? clockMinutes(window.end) : 1440;
  // A spring-forward gap can erase a whole weekly window. Scan through the following week.
  const maxDistance = 16 * dayMs;
  const origin = candidate;
  while (candidate >= anchor && candidate <= end && Math.abs(candidate - origin) <= maxDistance) {
    const local = new Date(wallTime(clock, candidate));
    const minute = local.getUTCHours() * 60 + local.getUTCMinutes();
    if ((!weekdays || weekdays.includes(local.getUTCDay())) && minute >= start && minute < stop) return candidate;
    candidate += direction * intervalMs;
  }
}

export function nextRoutineTime(schedule: RoutineSchedule, after: number): number | undefined {
  if (schedule.kind === "interval") return intervalTime(schedule, after, 1);
  if (schedule.kind === "cron") return cronCalendar(schedule).nextRun(new Date(after))?.getTime();
  if (schedule.kind !== "once") return recurringTime(schedule, after, 1);
  const at = Date.parse(schedule.at);
  return at > after ? at : undefined;
}

export function latestRoutineTime(schedule: RoutineSchedule, through: number): number | undefined {
  if (schedule.kind === "interval") return intervalTime(schedule, through, -1);
  if (schedule.kind === "cron") return cronCalendar(schedule).previousRuns(1, new Date(through + 1))[0]?.getTime();
  if (schedule.kind !== "once") return recurringTime(schedule, through, -1);
  const at = Date.parse(schedule.at);
  return at <= through ? at : undefined;
}

export type RoutineTiming = {
  timeZone: string;
  localDate: string;
  requestedTime: string;
  localTime: string;
  adjustment: 'gap_forward' | 'fold_earlier' | null;
  explanation: string | null;
};

/** Describe the same instant calculation used by Pi timers, without adding timer state. */
export function routineTiming(schedule: RoutineSchedule, at: number): RoutineTiming | undefined {
  if(schedule.kind==='once' || schedule.kind==='interval' || schedule.kind==='cron') return;
  const clock=wallClock(schedule.timeZone),local=new Date(wallTime(clock,at));
  const localDate=local.toISOString().slice(0,10),localTime=local.toISOString().slice(11,16);
  const requested=Date.parse(localDate+'T'+schedule.time+':00Z');
  const repeated=nearbyInstants(clock,requested).filter(instant=>wallTime(clock,instant)===requested).length>1;
  const adjustment=localTime!==schedule.time ? 'gap_forward' : repeated ? 'fold_earlier' : null;
  const explanation=adjustment==='gap_forward' ? `当地 ${schedule.time} 不存在，已顺延至 ${localTime}。` : adjustment==='fold_earlier' ? `当地 ${schedule.time} 重复出现，采用第一次。` : null;
  return {timeZone:schedule.timeZone,localDate,requestedTime:schedule.time,localTime,adjustment,explanation};
}
