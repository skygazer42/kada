export type RoutineSchedule =
  | { kind: "once"; at: string }
  | { kind: "daily"; time: string; timeZone: string }
  | { kind: "weekly"; weekday: number; time: string; timeZone: string };

const dayMs = 86_400_000;
const minuteMs = 60_000;

export function normalizeRoutineSchedule(schedule: RoutineSchedule): RoutineSchedule {
  if (!schedule || typeof schedule !== "object") throw new Error("A routine schedule is required.");
  if (schedule.kind === "once") {
    const at = typeof schedule.at === "string" ? Date.parse(schedule.at) : NaN;
    if (!Number.isFinite(at) || !/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/.test(schedule.at)) {
      throw new Error("A reminder must have an ISO datetime with an explicit offset.");
    }
    const date = new Date(schedule.at.slice(0, 10) + "T00:00:00Z");
    if (date.toISOString().slice(0, 10) !== schedule.at.slice(0, 10)) {
      throw new Error("A reminder must have a valid calendar date.");
    }
    return { kind: "once", at: new Date(at).toISOString() };
  }
  if (schedule.kind !== "daily" && schedule.kind !== "weekly") {
    throw new Error("A routine schedule must be once, daily, or weekly.");
  }
  if (typeof schedule.time !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(schedule.time)) {
    throw new Error("A recurring routine must have a local time in HH:MM format.");
  }
  if (typeof schedule.timeZone !== "string" || !schedule.timeZone || /^[+-]/.test(schedule.timeZone)) {
    throw new Error("A recurring routine must have an IANA time zone.");
  }
  const timeZone = wallClock(schedule.timeZone).resolvedOptions().timeZone;
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
  schedule: Exclude<RoutineSchedule, { kind: "once" }>,
  boundary: number,
  direction: 1 | -1,
): number {
  const clock = wallClock(schedule.timeZone);
  const local = new Date(wallTime(clock, boundary));
  const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  const hour = Number(schedule.time.slice(0, 2));
  const minute = Number(schedule.time.slice(3, 5));
  const days = schedule.kind === "weekly"
    ? ((schedule.weekday - local.getUTCDay()) * direction + 7) % 7
    : 0;
  const wall = midnight + direction * days * dayMs + (hour * 60 + minute) * minuteMs;
  const instant = instantAt(clock, wall);
  if (direction === 1 ? instant > boundary : instant <= boundary) return instant;
  const interval = schedule.kind === "weekly" ? 7 : 1;
  return instantAt(clock, wall + direction * interval * dayMs);
}

export function nextRoutineTime(schedule: RoutineSchedule, after: number): number | undefined {
  if (schedule.kind !== "once") return recurringTime(schedule, after, 1);
  const at = Date.parse(schedule.at);
  return at > after ? at : undefined;
}

export function latestRoutineTime(schedule: RoutineSchedule, through: number): number | undefined {
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
  if(schedule.kind==='once') return;
  const clock=wallClock(schedule.timeZone),local=new Date(wallTime(clock,at));
  const localDate=local.toISOString().slice(0,10),localTime=local.toISOString().slice(11,16);
  const requested=Date.parse(localDate+'T'+schedule.time+':00Z');
  const repeated=nearbyInstants(clock,requested).filter(instant=>wallTime(clock,instant)===requested).length>1;
  const adjustment=localTime!==schedule.time ? 'gap_forward' : repeated ? 'fold_earlier' : null;
  const explanation=adjustment==='gap_forward' ? `当地 ${schedule.time} 不存在，已顺延至 ${localTime}。` : adjustment==='fold_earlier' ? `当地 ${schedule.time} 重复出现，采用第一次。` : null;
  return {timeZone:schedule.timeZone,localDate,requestedTime:schedule.time,localTime,adjustment,explanation};
}
