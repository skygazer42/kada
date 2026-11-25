import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { awaitWithContext, BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, defineDoc, defineExtension, defineTask, Harness, type ConversationId, type Cursor, type Tx } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { acceptanceChecks, type AcceptanceCheck } from "./checks.js";
import { localEnvironment, shellEnvironment } from "./execution.js";
import { latestRoutineTime, nextRoutineTime, normalizeRoutineSchedule, routineTiming, type RoutineTiming, type RoutineSchedule } from "./routine-schedule.js";
import type { LocalRuntime } from "./runtime.js";
import { normalizeMcpPrecheck, type McpPrecheck, type McpTools } from "./mcp-tools.js";
import { githubIssueTarget, type GithubIssue } from "./github-routine-events.js";

export { nextRoutineTime, type RoutineSchedule } from "./routine-schedule.js";

export type RoutineBudget = {
  maxEstimatedCostUsd: number;
  maxDurationMs: number;
  maxTotalTokens?: number;
};
type EventIdentity = { source: string; type: string; eventId: string; issue?: GithubIssue };
type EventData = Record<string, string | number | boolean | null>;
type RoutineEvent = { source: string; type: string; equals: EventData };

export type RoutineInput = {
  id?: string;
  action: "notify" | "task";
  objective: string;
  workspace?: string;
  acceptance?: AcceptanceCheck[];
  schedule: RoutineSchedule;
  missedPolicy?: "run_once" | "skip";
  budgetPolicy?: "pause" | "skip";
  overlapPolicy?: "skip";
  notifyOnChange?: boolean;
  budget?: RoutineBudget;
  precheck?: { command: string[] } | { mcp: McpPrecheck };
  event?: RoutineEvent;
};

type RoutineDefinition = Omit<RoutineInput, "id" | "acceptance" | "missedPolicy" | "budgetPolicy" | "notifyOnChange"> & {
  acceptance: AcceptanceCheck[];
  missedPolicy: NonNullable<RoutineInput["missedPolicy"]>;
  budgetPolicy: NonNullable<RoutineInput["budgetPolicy"]>;
  notifyOnChange: boolean;
};

export type RoutineOccurrence = Omit<RoutineDefinition, "schedule" | "missedPolicy" | "overlapPolicy" | "event"> & {
  id: string;
  routineId: string;
  revision: number;
  scheduledAt: string;
  taskId: string;
  trigger?: "manual" | "event";
  event?: EventIdentity;
  timing?: RoutineTiming;
};

export type RoutineExecution =
  | { status?: "started"; taskId: string }
  | { status: "notified" | "budget_exhausted" };

type PrecheckResult =
  | { status: "changed" | "unchanged" | "pending"; sha256: string }
  | { status: "failed" | "interrupted"; detail: string };

type TaskOverview = Awaited<ReturnType<LocalRuntime["taskOverview"]>>;
type TaskState = TaskOverview["status"];
type StartedOccurrence = { occurrenceId: string; taskId: string };

type Receipt = Pick<RoutineOccurrence, "id" | "scheduledAt" | "trigger" | "event"> & {
  status: "claimed" | "notified" | "started" | "budget_exhausted" | "skipped" | "failed" | "interrupted";
  taskId?: string;
  detail?: string;
  timing?: RoutineTiming;
  precheck?: PrecheckResult;
  blockedBy?: StartedOccurrence & { status: TaskState };
  eventFingerprint?: string;
};

export type RoutineOccurrenceRecord = Receipt & {
  routineId: string;
  revision: number;
  action: RoutineInput['action'];
  objective: string;
  missedPolicy: 'run_once' | 'skip';
  budgetPolicy: 'pause' | 'skip';
  budget?: RoutineBudget;
  recordedAt: number;
};
export type RoutineHistoryRecord = RoutineOccurrenceRecord & {
  sequence: number;
  taskStatus?: TaskState | "missing";
  taskReason?: string;
  taskQuestion?: string;
  taskSummary?: string;
};
const occurrenceEntryKind='local.routine.occurrence';

async function recordOccurrence(tx:Tx,conversationId:ConversationId,rule:StoredRoutine,receipt:Receipt,recordedAt:number) {
  const data:RoutineOccurrenceRecord={...receipt,routineId:rule.id,revision:rule.revision,action:rule.action,objective:rule.objective,
    missedPolicy:rule.missedPolicy,budgetPolicy:rule.budgetPolicy,...(rule.budget ? {budget:rule.budget} : {}),recordedAt};
  await tx.appendEntry(conversationId,{kind:occurrenceEntryKind,data});
  return data;
}

async function interruptManual(tx: Tx, conversationId: ConversationId, rule: StoredRoutine, now: number) {
  const manual = rule.manual;
  if (!manual || manual.budgetSettled) return;
  const claim = manual.claim;
  const precheck = claim?.precheckResult;
  const admissionPossible = claim && (!claim.precheck || precheck?.status === "changed");
  await recordOccurrence(tx, conversationId, rule, {
    id: manual.accepted.id, scheduledAt: manual.accepted.scheduledAt, trigger: manual.accepted.trigger, status: "interrupted",
    ...(manual.accepted.event ? { event: manual.accepted.event } : {}),
    ...(admissionPossible && manual.accepted.taskId ? { taskId: manual.accepted.taskId } : {}),
    ...(precheck ? { precheck } : {}),
    detail: !claim ? "The rule changed before this run could begin."
      : admissionPossible ? "The run was interrupted during admission. Its task may already have started."
      : "The run was interrupted during precheck. The check may have had effects.",
  }, now);
}

async function manualReceipt(tx: Tx, conversationId: ConversationId, routineId: string, requestKey: string) {
  let cursor: Cursor | undefined;
  do {
    const page = await tx.scanEntries({ conversationId, order: "descending" }, 200, cursor);
    for (const entry of page.items) {
      if (entry.kind !== occurrenceEntryKind) continue;
      const data = entry.data as RoutineOccurrenceRecord;
      if ((data.trigger === "manual" && data.status === "claimed" || data.trigger === "event" && data.eventFingerprint) &&
        data.routineId === routineId && data.id.endsWith("/" + requestKey)) return data;
    }
    cursor = page.next;
  } while (cursor);
}

async function recordedOccurrence(tx:Tx,conversationId:ConversationId,id:string) {
  let record:RoutineOccurrenceRecord|undefined,cursor:Cursor|undefined;
  do {
    const page=await tx.scanEntries({conversationId,order:'descending'},200,cursor);
    for(const entry of page.items) if(entry.kind===occurrenceEntryKind && entry.data && typeof entry.data==='object' && !Array.isArray(entry.data) && entry.data.id===id) {
      const value=entry.data as RoutineOccurrenceRecord;
      record ??= value;
      if(value.status==='budget_exhausted') return {record,budgetRecorded:true};
    }
    cursor=page.next;
  } while(cursor);
  return {record,budgetRecorded:false};
}

export type Routine = RoutineDefinition & {
  id: string;
  revision: number;
  status: "scheduled" | "paused" | "completed" | "cancelled";
  nextRunAt?: string;
  nextTiming?: RoutineTiming;
  lastOccurrence?: Receipt;
};

type TimerId = Parameters<Harness["abortTask"]>[0];
type Claim = RoutineOccurrence & { precheckResult?: PrecheckResult };
type StoredRoutine = Routine & {
  timerId?: TimerId;
  claim?: Claim;
  manual?: { timerId: TimerId; accepted: Receipt; claim?: Claim; budgetSettled?: true };
  lastPrecheckSha256?: string;
  lastPrecheckScheduledAt?: string;
  lastStarted?: StartedOccurrence;
  firstSlotAfterResume?: string;
};

export interface LocalRoutineOptions {
  dataDir: string;
  execute(occurrence: RoutineOccurrence, signal: AbortSignal): Promise<RoutineExecution>;
  taskOverview?(taskId: string): Promise<TaskOverview | undefined>;
  mcp?: Pick<McpTools, "validatePrecheck" | "samplePrecheck">;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number, options: { readonly background: boolean }) => (() => void) | undefined;
}

export class RoutineError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string) {
    super(message);
  }
}

const routinesDoc = defineDoc({
  scope: "session",
  kind: "local.routines",
  version: 1,
  initial: (): { rules: Record<string, StoredRoutine> } => ({ rules: {} }),
  checkpointWhen: () => true,
});

type TimerInput = { routineId: string; revision: number; firstAt: number; manual?: RoutineOccurrence };
type TimerCheckpoint = { phase: "wait"; at: number } | { phase: "deliver"; at: number };
type Session = { harness: Harness; conversationId: ConversationId; timer: ReturnType<typeof makeTimer> };
const completed = { status: "terminal", outcome: { status: "completed", result: null } } as const;
const context = BACKGROUND_CONTEXT;
const keyFor = (id: string) => "routine:" + id;

function snapshot<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
}

function toRoutine({ timerId: _timer, claim: _claim, manual: _manual, lastPrecheckSha256: _baseline, lastPrecheckScheduledAt: _sample, lastStarted: _lastStarted, firstSlotAfterResume: _resumed, ...routine }: StoredRoutine): Routine {
  const nextTiming=routine.nextRunAt ? routineTiming(routine.schedule,Date.parse(routine.nextRunAt)) : undefined;
  return { ...routine, notifyOnChange: routine.notifyOnChange ?? false,...(nextTiming ? {nextTiming} : {}) };
}

function inputId(value: string | undefined): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,120}$/.test(value)) {
    throw new RoutineError(400, "A routine ID must contain 1 to 120 letters, digits, hyphens, or underscores.");
  }
  return value;
}

function eventData(value: unknown, nonempty = false): EventData {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RoutineError(400, "Event fields must be a scalar object.");
  const entries = Object.entries(value);
  if (entries.length > 32 || (nonempty && !entries.length) || entries.some(([key, item]) =>
    !/^[A-Za-z0-9_-]{1,80}$/.test(key) || !(item === null || typeof item === "boolean" ||
      typeof item === "number" && Number.isFinite(item) || typeof item === "string" && item.length <= 1024))) {
    throw new RoutineError(400, "An event supports up to 32 scalar fields and 1024 characters per value.");
  }
  return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)));
}

function eventName(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/.test(value)) {
    throw new RoutineError(400, "An event source or type must be a name of at most 120 characters.");
  }
  return value;
}

function eventRule(value: RoutineEvent): RoutineEvent {
  if (!value || Object.keys(value).some(key => !["source", "type", "equals"].includes(key))) throw new RoutineError(400, "Invalid event filter.");
  return { source: eventName(value.source), type: eventName(value.type), equals: eventData(value.equals, true) };
}

function definition(input: RoutineInput): RoutineDefinition {
  if (!input || (input.action !== "task" && input.action !== "notify")) {
    throw new RoutineError(400, "A routine action must be task or notify.");
  }
  if (typeof input.objective !== "string" || !input.objective.trim()) {
    throw new RoutineError(400, "A routine objective is required.");
  }
  if (input.workspace !== undefined && (typeof input.workspace !== "string" || !input.workspace.trim())) {
    throw new RoutineError(400, "A routine workspace must be a directory path.");
  }
  let schedule: RoutineSchedule;
  let acceptance: AcceptanceCheck[];
  try {
    schedule = normalizeRoutineSchedule(input.schedule);
    acceptance = acceptanceChecks(input.acceptance ?? []);
  } catch (error) {
    throw new RoutineError(400, error instanceof Error ? error.message : "Invalid routine schedule.");
  }
  if (schedule.kind === "event" && input.event === undefined) {
    throw new RoutineError(400, "An event-only routine requires an event filter.");
  }
  const missedPolicy = input.missedPolicy === undefined
    ? (schedule.kind === "once" ? "run_once" : "skip")
    : input.missedPolicy;
  if (missedPolicy !== "run_once" && missedPolicy !== "skip") {
    throw new RoutineError(400, "A routine missed policy must be run_once or skip.");
  }
  const budgetPolicy = input.budgetPolicy === undefined ? "pause" : input.budgetPolicy;
  if (budgetPolicy !== "pause" && budgetPolicy !== "skip") {
    throw new RoutineError(400, "A routine budget policy must be pause or skip.");
  }
  const overlapPolicy = input.overlapPolicy;
  if (overlapPolicy !== undefined && (overlapPolicy !== "skip" || input.action !== "task" || schedule.kind === "once")) {
    throw new RoutineError(400, "The skip overlap policy requires a recurring task.");
  }
  if (input.notifyOnChange !== undefined && typeof input.notifyOnChange !== "boolean") {
    throw new RoutineError(400, "The notifyOnChange setting must be a boolean.");
  }
  let precheck = input.precheck;
  if (precheck !== undefined) {
    if (!precheck || typeof precheck !== "object" || Array.isArray(precheck) || input.action !== "task" || !input.workspace ||
      Object.keys(precheck).length !== 1) throw new RoutineError(400, "A precheck requires a task workspace and exactly one command or MCP check.");
    if ("mcp" in precheck) precheck = { mcp: normalizeMcpPrecheck(precheck.mcp) };
    else if ("command" in precheck && Array.isArray(precheck.command) && precheck.command.length <= 64 &&
      typeof precheck.command[0] === "string" && precheck.command[0].trim() &&
      precheck.command.every(arg => typeof arg === "string" && !arg.includes("\0")) && precheck.command.join("").length <= 16_000) {
      precheck = { command: [...precheck.command] };
    } else throw new RoutineError(400, "A precheck requires a command argument array or a tested MCP tool.");
  }
  const budget = input.budget;
  if (budget !== undefined && (
    !budget || input.action !== "task" ||
    !Number.isFinite(budget.maxEstimatedCostUsd) || budget.maxEstimatedCostUsd <= 0 ||
    !Number.isSafeInteger(budget.maxDurationMs) || budget.maxDurationMs <= 0 ||
    (budget.maxTotalTokens !== undefined && (!Number.isSafeInteger(budget.maxTotalTokens) || budget.maxTotalTokens <= 0))
  )) {
    throw new RoutineError(400, "A task budget must have positive cost and duration limits and an optional positive token limit.");
  }
  return {
    action: input.action,
    objective: input.objective.trim(),
    ...(input.workspace ? { workspace: precheck ? resolve(input.workspace.trim()) : input.workspace.trim() } : {}),
    acceptance,
    schedule,
    missedPolicy,
    budgetPolicy,
    ...(overlapPolicy ? { overlapPolicy } : {}),
    notifyOnChange: input.notifyOnChange ?? false,
    ...(input.event === undefined ? {} : { event: eventRule(input.event) }),
    ...(precheck ? { precheck } : {}),
    ...(budget ? {
      budget: {
        maxEstimatedCostUsd: budget.maxEstimatedCostUsd,
        maxDurationMs: budget.maxDurationMs,
        ...(budget.maxTotalTokens !== undefined ? { maxTotalTokens: budget.maxTotalTokens } : {}),
      },
    } : {}),
  };
}

function firstTime(schedule: RoutineSchedule, now: number): number {
  const at = schedule.kind === "once" ? Date.parse(schedule.at) : nextRoutineTime(schedule, schedule.kind === "interval" ? now - 1 : now);
  if (at === undefined) throw new RoutineError(400, "This routine has no future occurrences.");
  if (at < now) throw new RoutineError(400, "A new reminder must be scheduled at or after the current time.");
  return at;
}

function taskIdFor(id:string) {
  const bytes = createHash("sha256").update("kada/routine/" + id).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
}

function occurrenceFor(rule: StoredRoutine, at: number, requestKey?: string): RoutineOccurrence {
  const scheduledAt = new Date(at).toISOString();
  const id = [rule.id, rule.revision, requestKey ?? scheduledAt].join("/");
  const taskId=taskIdFor(id);
  const { action, objective, workspace, acceptance, budget, budgetPolicy, notifyOnChange, precheck } = rule;
  const timing = requestKey ? undefined : routineTiming(rule.schedule, at);
  return {
    id, routineId: rule.id, revision: rule.revision, scheduledAt, taskId, action, objective, acceptance, budgetPolicy,
    notifyOnChange: notifyOnChange ?? false,
    ...(requestKey ? { trigger: "manual" as const } : {}),
    ...(timing?.adjustment ? {timing} : {}),
    ...(workspace ? { workspace } : {}),
    ...(budget ? { budget } : {}),
    ...(precheck ? { precheck } : {}),
  };
}

function endSchedule(rule: StoredRoutine, status: "paused" | "completed" | "cancelled"): StoredRoutine {
  const { nextRunAt: _next, timerId: _timer, claim: _claim, ...record } = rule;
  return { ...record, status };
}

function recordStarted(rule: StoredRoutine, receipt: Receipt): StoredRoutine {
  const saved = { ...rule };
  if (rule.overlapPolicy === "skip" && receipt.status === "started" && receipt.taskId) {
    saved.lastStarted = { occurrenceId: receipt.id, taskId: receipt.taskId };
  }
  if (receipt.status === "started" && receipt.precheck?.status === "changed" &&
    (!rule.lastPrecheckScheduledAt || rule.lastPrecheckScheduledAt <= receipt.scheduledAt)) {
    saved.lastPrecheckSha256 = receipt.precheck.sha256;
    saved.lastPrecheckScheduledAt = receipt.scheduledAt;
  }
  return saved;
}

function advance(rule: StoredRoutine, receipt: Receipt, now: number) {
  const saved = { ...recordStarted(rule, receipt), lastOccurrence: receipt };
  if (receipt.status === "budget_exhausted" && rule.budgetPolicy === "pause") {
    return { rule: endSchedule(saved, "paused"), state: completed };
  }
  const next = nextRoutineTime(rule.schedule, now);
  if (next === undefined || rule.schedule.kind === "once") {
    return { rule: endSchedule(saved, "completed"), state: completed };
  }
  const { claim: _claim, ...record } = saved;
  return {
    rule: { ...record, nextRunAt: new Date(next).toISOString() },
    state: { status: "sleeping", until: next, checkpoint: { phase: "deliver", at: next } } as const,
  };
}

async function samplePrecheck(workspace: string, precheck: NonNullable<RoutineInput["precheck"]>, ctx: typeof context, mcp: LocalRoutineOptions["mcp"]) {
  if ("mcp" in precheck) {
    try {
      if (!mcp) throw new Error("MCP prechecks are unavailable.");
      return await mcp.samplePrecheck(workspace, precheck.mcp,
        AbortSignal.any([AbortSignal.timeout(30_000), ...(ctx.abortSignal ? [ctx.abortSignal] : [])]));
    } catch {
      ctx.abortSignal?.throwIfAborted();
      return { detail: "MCP precheck failed. Check its connection, permissions and read-only tool." };
    }
  }
  const output = createHash("sha256");
  const result = await localEnvironment(workspace).exec(precheck.command, {
    timeout: 30, inheritEnv: false, env: shellEnvironment(),
    onOutput(text, _ctx, info) { if (info.stream === "stdout") output.update(text); },
  }, ctx);
  if (!result.ok) return { detail: result.error.code === "timeout" ? "Precheck timed out." : "Precheck execution failed." };
  if (result.value.exitCode !== 0) return { detail: `Precheck exited with code ${result.value.exitCode}.` };
  return { sha256: output.digest("hex") };
}

function makeTimer(options: LocalRoutineOptions, openedAt: number) {
  return defineTask<TimerInput, TimerCheckpoint, null>({
    name: "local.routine.timer",
    version: 1,
    initial: (input) => ({ phase: input.manual ? "deliver" : "wait", at: input.firstAt }),
    phases: {
      wait: (task, runtime, ctx) => {
        const at = task.state.checkpoint.at;
        return runtime.sleepUntil(at, { phase: "deliver", at }, ctx);
      },
      deliver: async (task, runtime, ctx) => {
        const { routineId, revision, manual } = task.input;
        const key = keyFor(routineId);
        const current = (rule: StoredRoutine | undefined): rule is StoredRoutine => Boolean(rule && rule.revision === revision &&
          (manual ? rule.manual?.timerId === task.id : rule.timerId === task.id && rule.status === "scheduled"));
        const claimFor = (rule: StoredRoutine) => manual ? rule.manual?.claim : rule.claim;
        const storeClaim = (rule: StoredRoutine, claim: Claim): StoredRoutine => manual
          ? { ...rule, manual: { ...rule.manual!, claim } }
          : { ...rule, claim };
        const finish = (rules: Record<string, StoredRoutine>, rule: StoredRoutine, receipt: Receipt, now: number) => {
          if (manual) {
            const saved = recordStarted(rule, receipt);
            delete saved.manual;
            rules[key] = receipt.trigger === "event" && receipt.status === "budget_exhausted" &&
              saved.schedule.kind === "event" && saved.budgetPolicy === "pause" ? endSchedule(saved, "paused") : saved;
            return completed;
          }
          const advanced = advance(rule, receipt, now);
          rules[key] = advanced.rule;
          return advanced.state;
        };
        let occurrence: RoutineOccurrence | undefined;
        let precheck: PrecheckResult | undefined;
        let newClaim = false;
        let previousTaskId: string | undefined;
        const claimDue = (checked?: { taskId: string; status?: TaskState; failed?: true }) => runtime.commit(async (tx) => {
          const { rules } = await tx.doc(routinesDoc);
          const rule = snapshot(rules[key]);
          if (!current(rule)) return completed;
          const claim = claimFor(rule);
          if (claim) {
            occurrence = { ...claim, notifyOnChange: claim.notifyOnChange ?? false };
            precheck = claim.precheckResult;
            return;
          }
          const now = runtime.now();
          const at = task.state.checkpoint.at;
          const latest = manual ? undefined : latestRoutineTime(rule.schedule, now);
          const missed = at < openedAt || (latest !== undefined && latest > at);
          const due = manual ?? occurrenceFor(rule, latest === undefined ? at : Math.max(at, latest));
          const skipMissed = !manual && missed && rule.missedPolicy === "skip";
          let blockedBy: Receipt["blockedBy"];
          if (!skipMissed && rule.overlapPolicy === "skip") {
            const otherClaim = manual ? rule.claim : rule.manual?.claim;
            if (otherClaim) {
              blockedBy = { occurrenceId: otherClaim.id, taskId: otherClaim.taskId, status: "pending" };
            } else if (options.taskOverview && rule.lastStarted) {
              if (checked?.taskId !== rule.lastStarted.taskId) {
                previousTaskId = rule.lastStarted.taskId;
                return;
              }
              if (checked.failed) {
                const failure: Receipt = {
                  id: due.id, scheduledAt: due.scheduledAt, status: "failed", detail: "Could not read the prior task status.",
                  ...(due.trigger ? { trigger: due.trigger } : {}), ...(due.event ? { event: due.event } : {}), ...(due.timing ? { timing: due.timing } : {}),
                };
                await recordOccurrence(tx, runtime.conversationId, rule, failure, now);
                return finish(rules, rule, failure, now);
              }
              const status = checked.status;
              if (status && !["completed", "answered", "cancelled", "failed", "budget_limited"].includes(status)) {
                blockedBy = { ...rule.lastStarted, status };
              }
            }
          }
          if (skipMissed || blockedBy) {
            const skipped: Receipt = {
              id: due.id, scheduledAt: due.scheduledAt, status: "skipped",
              ...(due.trigger ? { trigger: due.trigger } : {}), ...(due.event ? { event: due.event } : {}),
              ...(due.timing ? { timing: due.timing } : {}), ...(blockedBy ? { blockedBy } : {}),
            };
            await recordOccurrence(tx, runtime.conversationId, rule, skipped, now);
            return finish(rules, rule, skipped, now);
          }
          if (!manual) await recordOccurrence(tx,runtime.conversationId,rule,{id:due.id,scheduledAt:due.scheduledAt,status:'claimed',...(due.action==='task' ? {taskId:due.taskId} : {}),...(due.timing ? {timing:due.timing} : {})},now);
          rules[key] = storeClaim(rule, due);
          occurrence = due;
          newClaim = true;
        }, ctx);
        await claimDue();
        // Budget settlement can abort this timer before its queued task lookup runs.
        while (previousTaskId && options.taskOverview && !runtime.signal.aborted) {
          const taskId = previousTaskId;
          previousTaskId = undefined;
          let overview: TaskOverview | undefined;
          try {
            overview = await awaitWithContext(options.taskOverview(taskId), ctx);
          } catch {
            if (runtime.signal.aborted) return;
            await claimDue({ taskId, failed: true });
            continue;
          }
          await claimDue({ taskId, status: overview?.status });
        }
        if (!occurrence || runtime.signal.aborted) return;

        const due = occurrence;
        const { id, scheduledAt } = due;
        if (due.precheck && newClaim) {
          const sample = await samplePrecheck(due.workspace!, due.precheck, ctx, options.mcp);
          if (runtime.signal.aborted) return;
          await runtime.commit(async (tx) => {
            const { rules } = await tx.doc(routinesDoc);
            const rule = snapshot(rules[key]);
            if (!current(rule)) return completed;
            const claim = claimFor(rule);
            if (claim?.id !== id) return completed;
            if ("detail" in sample) {
              precheck = { status: "failed", detail: sample.detail };
            } else {
              const other = (manual ? rule.claim : rule.manual?.claim)?.precheckResult;
              const status = sample.sha256 === rule.lastPrecheckSha256 ? "unchanged"
                : other?.status === "changed" && other.sha256 === sample.sha256 ? "pending" : "changed";
              precheck = { status, sha256: sample.sha256 };
            }
            rules[key] = storeClaim(rule, { ...claim, precheckResult: precheck });
          }, ctx);
          if (!precheck || runtime.signal.aborted) return;
        } else if (due.precheck && !precheck) {
          precheck = { status: "interrupted", detail: "The prior check may have run. Inspect actual state before retrying." };
        }
        const timing=occurrence.timing ? {timing:occurrence.timing} : {};
        const evidence = { id, scheduledAt, ...timing, ...(due.trigger ? { trigger: due.trigger } : {}),
          ...(due.event ? { event: due.event } : {}), ...(precheck ? { precheck } : {}) };
        let receipt: Receipt;
        try {
          if (precheck && precheck.status !== "changed") {
            receipt = { ...evidence, status: precheck.status === "unchanged" || precheck.status === "pending" ? "skipped" : "failed" };
          } else {
            const result = await awaitWithContext(options.execute(due, runtime.signal), ctx);
            receipt = { ...evidence, status: result.status ?? "started", ...("taskId" in result ? { taskId: result.taskId } : {}) };
          }
        } catch {
          receipt = { ...evidence, status: "failed" };
        }
        if (runtime.signal.aborted) return;

        await runtime.commit(async (tx) => {
          const { rules } = await tx.doc(routinesDoc);
          const rule = snapshot(rules[key]);
          if (!current(rule) || claimFor(rule)?.id !== id) return completed;
          if (manual) {
            if (!rule.manual?.budgetSettled) await recordOccurrence(tx, runtime.conversationId, rule, receipt, runtime.now());
            return finish(rules, rule, rule.manual?.budgetSettled ? { ...receipt, status: "budget_exhausted" } : receipt, runtime.now());
          }
          const known = rule.lastOccurrence;
          if(known?.id!==id || known.status!=='budget_exhausted') await recordOccurrence(tx,runtime.conversationId,rule,receipt,runtime.now());
          return finish(rules, rule, known?.id === id && known.status === "budget_exhausted" ? known : receipt, runtime.now());
        }, ctx);
      },
    },
    abort: async (_task, runtime, ctx) => {
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
    },
  });
}

export class LocalRoutines {
  private session?: Promise<Session>;
  private readonly now: () => number;

  constructor(private readonly options: LocalRoutineOptions) {
    this.now = options.now ?? Date.now;
  }

  async recover(): Promise<void> {
    const {harness}=await this.open();
    harness.resume();
  }

  private open(): Promise<Session> {
    return this.session ??= this.openSession();
  }

  private async openSession(): Promise<Session> {
    const openedAt = this.now();
    const timer = makeTimer(this.options, openedAt);
    const registry = createRegistry();
    registry.install(defineExtension({ name: "local_routines", tasks: [timer] }));
    await mkdir(this.options.dataDir, { recursive: true });
    const harness = await Harness.open(await openNodeSqliteStorage(join(this.options.dataDir, "routines.sqlite")), {
      models: createModels(),
      registry,
      now: this.now,
      ...(this.options.setTimer ? { setTimer: this.options.setTimer } : {}),
    }, context);
    try {
      const root = await harness.root(context);
      // Recovered rule changes can precede their old timer's abort mark on disk.
      const current = await harness.commit(async tx => {
        const { rules } = await tx.doc(routinesDoc);
        return new Set(Object.values(rules).flatMap(rule => [rule.timerId, rule.manual?.timerId]));
      }, context);
      for (const { record } of (await harness.inspect(context)).tasks) {
        if (record.kind === timer.definition.name && record.conversationId === root.id && !current.has(record.id)) {
          await harness.abortTask(record.id, context);
        }
      }
      return { harness, conversationId: root.id, timer };
    } catch (error) {
      await harness.close(context);
      throw error;
    }
  }

  private async validatePrecheck(details: RoutineDefinition) {
    if (!details.precheck || !("mcp" in details.precheck)) return;
    if (!this.options.mcp) throw new RoutineError(400, "MCP prechecks are unavailable.");
    try { await this.options.mcp.validatePrecheck(details.workspace!, details.precheck.mcp); }
    catch (error) { throw new RoutineError(400, (error as Error).message); }
  }

  async create(input: RoutineInput): Promise<Routine> {
    const details = definition(input);
    await this.validatePrecheck(details);
    const id = input.id === undefined ? randomUUID() : inputId(input.id);
    const { harness, conversationId, timer } = await this.open();
    const routine = await harness.commit(async (tx) => {
      const { rules } = await tx.doc(routinesDoc);
      const key = keyFor(id);
      const previous = snapshot(rules[key]);
      if (previous) {
        if (JSON.stringify(definition(previous)) !== JSON.stringify(details)) {
          throw new RoutineError(409, "This routine ID already belongs to a different request.");
        }
        return toRoutine(previous);
      }
      const next: StoredRoutine = { ...details, id, revision: 1, status: "scheduled" };
      if (details.schedule.kind !== "event") {
        const firstAt = firstTime(details.schedule, this.now());
        next.nextRunAt = new Date(firstAt).toISOString();
        next.timerId = await tx.createTask(timer, { routineId: id, revision: 1, firstAt }, {
          ownership: { kind: "conversation" }, conversationId,
        });
      }
      rules[key] = next;
      return toRoutine(next);
    }, context);
    harness.resume();
    return routine;
  }

  async list(): Promise<Routine[]> {
    const { harness } = await this.open();
    return harness.commit(async (tx) => {
      const { rules } = await tx.doc(routinesDoc);
      return Object.values(snapshot(rules)).map(toRoutine);
    }, context);
  }

  async runNow(id: string, requestId: string): Promise<RoutineOccurrenceRecord> {
    const key = keyFor(inputId(id));
    if (typeof requestId !== "string" || !/^[A-Za-z0-9_-]{1,120}$/.test(requestId)) {
      throw new RoutineError(400, "A request ID must contain 1 to 120 letters, digits, hyphens, or underscores.");
    }
    const requestKey = "manual-" + createHash("sha256").update(requestId).digest("hex");
    const { harness, conversationId, timer } = await this.open();
    const accepted = await harness.commit(async tx => {
      const { rules } = await tx.doc(routinesDoc);
      const rule = snapshot(rules[key]);
      if (!rule) throw new RoutineError(404, "Routine not found.");
      const previous = await manualReceipt(tx, conversationId, id, requestKey);
      if (previous) return previous;
      if (rule.status !== "scheduled") throw new RoutineError(409, "Only a scheduled rule can run immediately.");
      if (rule.manual) throw new RoutineError(409, "An immediate run for this rule is still being admitted.");
      const firstAt = this.now();
      const manual = occurrenceFor(rule, firstAt, requestKey);
      const timerId = await tx.createTask(timer, { routineId: id, revision: rule.revision, firstAt, manual }, {
        ownership: { kind: "conversation" }, conversationId,
      });
      const receipt: Receipt = {
        id: manual.id, scheduledAt: manual.scheduledAt, status: "claimed", trigger: "manual",
        ...(manual.action === "task" ? { taskId: manual.taskId } : {}),
      };
      rules[key] = { ...rule, manual: { timerId, accepted: receipt } };
      return recordOccurrence(tx, conversationId, rule, receipt, firstAt);
    }, context);
    harness.resume();
    return accepted;
  }

  async receiveEvent(id: string, input: unknown, expectedRevision?: number): Promise<{ outcome: "filtered" | "accepted"; receipt?: RoutineOccurrenceRecord }> {
    const key = keyFor(inputId(id));
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(field =>
      !["source", "type", "eventId", "data"].includes(field))) throw new RoutineError(400, "Invalid event delivery.");
    const value = input as Record<string, unknown>;
    if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)) {
      throw new RoutineError(400, "Provide a valid expected routine revision.");
    }
    const event = { source: eventName(value.source), type: eventName(value.type), eventId: inputId(value.eventId as string) };
    const data = eventData(value.data);
    const fingerprint = createHash("sha256").update(JSON.stringify({ ...event, data })).digest("hex");
    const requestKey = "event-" + createHash("sha256").update(JSON.stringify([event.source, event.eventId])).digest("hex");
    const { harness, conversationId, timer } = await this.open();
    const result = await harness.commit(async tx => {
      const { rules } = await tx.doc(routinesDoc);
      const rule = snapshot(rules[key]);
      if (!rule) throw new RoutineError(404, "Routine not found.");
      const previous = await manualReceipt(tx, conversationId, id, requestKey);
      if (previous) {
        if (previous.eventFingerprint !== fingerprint) throw new RoutineError(409, "This event ID already has different content.");
        return { outcome: previous.status === "claimed" ? "accepted" as const : "filtered" as const, receipt: previous };
      }
      if (expectedRevision !== undefined && rule.revision !== expectedRevision) {
        throw new RoutineError(409, "The routine changed during event sync. Run the sync again.");
      }
      if (!rule.event) throw new RoutineError(409, "This routine has no event filter.");
      if (rule.event.source !== event.source || rule.event.type !== event.type) return { outcome: "filtered" as const };
      if (rule.status !== "scheduled") throw new RoutineError(409, "Only a scheduled rule can receive a new event.");
      const matches = Object.entries(rule.event.equals).every(([field, expected]) => Object.hasOwn(data, field) && data[field] === expected);
      if (matches && rule.manual) throw new RoutineError(409, "An immediate run for this rule is still being admitted.");
      const now = this.now();
      const issue = event.source === "github" && event.type === "issues.opened" ? githubIssueTarget(data.repository, data.number) : undefined;
      const identity = { ...event, ...(issue ? { issue } : {}) };
      const occurrence = { ...occurrenceFor(rule, now, requestKey), trigger: "event" as const, event: identity };
      const receipt: Receipt = { id: occurrence.id, scheduledAt: occurrence.scheduledAt, trigger: "event", event: identity,
        eventFingerprint: fingerprint, status: matches ? "claimed" : "skipped",
        ...(matches && occurrence.action === "task" ? { taskId: occurrence.taskId } : {}) };
      if (matches) {
        const timerId = await tx.createTask(timer, { routineId: id, revision: rule.revision, firstAt: now, manual: occurrence }, {
          ownership: { kind: "conversation" }, conversationId,
        });
        rules[key] = { ...rule, manual: { timerId, accepted: receipt } };
      }
      return { outcome: matches ? "accepted" as const : "filtered" as const,
        receipt: await recordOccurrence(tx, conversationId, rule, receipt, now) };
    }, context);
    harness.resume();
    return result;
  }

  async history(id: string, includeTaskStatus = false): Promise<RoutineHistoryRecord[]> {
    const key=keyFor(inputId(id));
    const {harness,conversationId}=await this.open();
    await harness.commit(async tx=>{if(!(await tx.doc(routinesDoc)).rules[key]) throw new RoutineError(404,'Routine not found.');},context);
    const root=(await harness.conversation(conversationId,context))!;
    const records: RoutineHistoryRecord[] = [];
    let cursor:Cursor|undefined;
    do {
      const page=await root.entries({order:'ascending'},200,cursor,context);
      for(const entry of page.items) if(entry.kind===occurrenceEntryKind && entry.data && typeof entry.data==='object' && !Array.isArray(entry.data) && entry.data.routineId===id) {
        records.push({...entry.data as RoutineOccurrenceRecord,sequence:Number(entry.id)});
      }
      cursor=page.next;
    } while(cursor);
    if (includeTaskStatus && this.options.taskOverview) {
      const overviews = new Map<string, TaskOverview | undefined>();
      for (const record of records) {
        if (!record.taskId) continue;
        if (!overviews.has(record.taskId)) overviews.set(record.taskId, await this.options.taskOverview(record.taskId));
        const overview = overviews.get(record.taskId);
        record.taskStatus = overview?.status ?? "missing";
        if (overview?.reason) record.taskReason = overview.reason.slice(0, 2000);
        if (overview?.question) record.taskQuestion = overview.question;
        if (overview?.summary) record.taskSummary = overview.summary.slice(0, 2000);
      }
    }
    return records;
  }

  async update(id: string, input: RoutineInput): Promise<Routine> {
    const key = keyFor(inputId(id));
    if (input?.id !== undefined && input.id !== id) throw new RoutineError(400, "A routine update cannot change its ID.");
    const details = definition(input);
    await this.validatePrecheck(details);
    const { harness, conversationId, timer } = await this.open();
    const result = await harness.commit(async (tx) => {
      const { rules } = await tx.doc(routinesDoc);
      const previous = snapshot(rules[key]);
      if (!previous) throw new RoutineError(404, "Routine not found.");
      if (previous.status === "cancelled") throw new RoutineError(409, "This routine was cancelled.");
      if (previous.status === "scheduled" && JSON.stringify(definition(previous)) === JSON.stringify(details)) {
        return { routine: toRoutine(previous) };
      }
      const revision = previous.revision + 1;
      const next: StoredRoutine = {
        ...details, id, revision, status: "scheduled",
        ...(previous.lastOccurrence ? { lastOccurrence: previous.lastOccurrence } : {}),
      };
      if (details.schedule.kind !== "event") {
        const firstAt = firstTime(details.schedule, this.now());
        next.nextRunAt = new Date(firstAt).toISOString();
        next.timerId = await tx.createTask(timer, { routineId: id, revision, firstAt }, {
          ownership: { kind: "conversation" }, conversationId,
        });
      }
      await interruptManual(tx, conversationId, previous, this.now());
      rules[key] = next;
      return { routine: toRoutine(next), previousTimer: previous.timerId, manualTimer: previous.manual?.timerId };
    }, context);
    if (result.manualTimer) await harness.abortTask(result.manualTimer, context);
    if (result.previousTimer) await harness.abortTask(result.previousTimer, context);
    harness.resume();
    return result.routine;
  }

  async cancel(id: string): Promise<Routine> {
    const key = keyFor(inputId(id));
    const { harness, conversationId } = await this.open();
    const result = await harness.commit(async (tx) => {
      const { rules } = await tx.doc(routinesDoc);
      const previous = snapshot(rules[key]);
      if (!previous) throw new RoutineError(404, "Routine not found.");
      if (previous.status === "cancelled") return { routine: toRoutine(previous) };
      const next = endSchedule(previous, "cancelled");
      await interruptManual(tx, conversationId, previous, this.now());
      delete next.manual;
      rules[key] = next;
      return { routine: toRoutine(next), previousTimer: previous.timerId, manualTimer: previous.manual?.timerId };
    }, context);
    if (result.manualTimer) await harness.abortTask(result.manualTimer, context);
    if (result.previousTimer) await harness.abortTask(result.previousTimer, context);
    harness.resume();
    return result.routine;
  }

  async pause(id: string): Promise<Routine> {
    return this.setPaused(id, true);
  }

  async resume(id: string): Promise<Routine> {
    return this.setPaused(id, false);
  }

  private async setPaused(id: string, paused: boolean): Promise<Routine> {
    const key = keyFor(inputId(id));
    const { harness, conversationId, timer } = await this.open();
    const result = await harness.commit(async tx => {
      const { rules } = await tx.doc(routinesDoc);
      const rule = snapshot(rules[key]);
      if (!rule) throw new RoutineError(404, "Routine not found.");
      if (rule.schedule.kind === "once" || (rule.status !== "scheduled" && rule.status !== "paused")) {
        throw new RoutineError(409, "Only a scheduled or paused recurring rule can change its pause status.");
      }
      if (paused) {
        if (rule.status === "paused") return { routine: toRoutine(rule) };
        const next = endSchedule(rule, "paused");
        // A claimed task may have been admitted before the timer could record its result.
        const claim = rule.claim ?? rule.manual?.claim;
        if (rule.overlapPolicy === "skip" && claim) {
          next.lastStarted = { occurrenceId: claim.id, taskId: claim.taskId };
        }
        await interruptManual(tx, conversationId, rule, this.now());
        delete next.manual;
        rules[key] = next;
        return { routine: toRoutine(next), previousTimer: rule.timerId, manualTimer: rule.manual?.timerId };
      }
      if (rule.status === "scheduled") return { routine: toRoutine(rule) };
      if (rule.schedule.kind === "event") {
        const next = { ...rule, status: "scheduled", firstSlotAfterResume: new Date(this.now()).toISOString() } as const;
        rules[key] = next;
        return { routine: toRoutine(next) };
      }
      const firstAt = nextRoutineTime(rule.schedule, this.now());
      if (firstAt === undefined) throw new RoutineError(409, "This routine has no future occurrence.");
      const timerId = await tx.createTask(timer, { routineId: id, revision: rule.revision, firstAt }, {
        ownership: { kind: "conversation" }, conversationId,
      });
      const nextRunAt = new Date(firstAt).toISOString();
      const next: StoredRoutine = { ...rule, status: "scheduled", nextRunAt, timerId, firstSlotAfterResume: nextRunAt };
      rules[key] = next;
      return { routine: toRoutine(next) };
    }, context);
    if (result.manualTimer) await harness.abortTask(result.manualTimer, context);
    if (result.previousTimer) await harness.abortTask(result.previousTimer, context);
    harness.resume();
    return result.routine;
  }

  async settleBudget(occurrenceId: string): Promise<void> {
    const [id, revision, keyPart, extra] = occurrenceId.split("/");
    if (!id || !revision || !keyPart || extra !== undefined) return;
    const manual = /^(?:manual|event)-[a-f0-9]{64}$/.test(keyPart);
    if (!manual && !Number.isFinite(Date.parse(keyPart))) return;
    const key = keyFor(id);
    const { harness,conversationId } = await this.open();
    const previousTimer = await harness.commit(async (tx) => {
      const { rules } = await tx.doc(routinesDoc);
      const rule = snapshot(rules[key]);
      const known=await recordedOccurrence(tx,conversationId,occurrenceId);
      if(known.budgetRecorded) return;
      let origin=known.record;
      if(!manual && !origin && rule && String(rule.revision)===revision && rule.action==='task' && (rule.claim?.id===occurrenceId || rule.lastOccurrence?.id===occurrenceId)) {
        const occurrence=occurrenceFor(rule,Date.parse(keyPart));
        origin={id:occurrenceId,scheduledAt:keyPart,status:'claimed',taskId:occurrence.taskId,...(occurrence.timing ? {timing:occurrence.timing} : {}),routineId:rule.id,revision:rule.revision,action:rule.action,objective:rule.objective,missedPolicy:rule.missedPolicy,budgetPolicy:rule.budgetPolicy,...(rule.budget ? {budget:rule.budget} : {}),recordedAt:this.now()};
      }
      if(!origin || origin.action!=='task') return;
      const { scheduledAt } = origin;
      const claim = manual ? rule?.manual?.claim : rule?.claim;
      const precheck = origin.precheck ?? (claim?.id === occurrenceId ? claim.precheckResult : undefined);
      const lastOccurrence:Receipt={id:occurrenceId,scheduledAt,status:'budget_exhausted',taskId:origin.taskId ?? taskIdFor(occurrenceId),...(origin.timing ? {timing:origin.timing} : {}),...(precheck ? {precheck} : {})};
      await tx.appendEntry(conversationId,{kind:occurrenceEntryKind,data:{...origin,...lastOccurrence,recordedAt:this.now()}});
      if (manual) {
        if (rule?.manual && claim?.id === occurrenceId) {
          rules[key] = { ...rule, manual: { ...rule.manual, budgetSettled: true } };
        }
        if (origin.trigger === "event" && rule?.schedule.kind === "event" && rule.status === "scheduled" &&
          String(rule.revision) === revision && rule.budgetPolicy === "pause" &&
          (!rule.firstSlotAfterResume || scheduledAt >= rule.firstSlotAfterResume)) {
          rules[key] = endSchedule(rules[key]!, "paused");
        }
        return;
      }
      if(!rule || String(rule.revision)!==revision || rule.action!=='task' || rule.status==='cancelled') return;
      if (rule.firstSlotAfterResume && scheduledAt < rule.firstSlotAfterResume) return;
      const previous=rule.lastOccurrence;
      const next = !previous || previous.scheduledAt <= scheduledAt ? { ...rule, lastOccurrence } : rule;
      if (rule.budgetPolicy === "pause") {
        rules[key] = endSchedule(next, "paused");
        return rule.timerId;
      }
      rules[key] = next;
      return undefined;
    }, context);
    if (previousTimer) await harness.abortTask(previousTimer, context);
  }

  async close(): Promise<void> {
    const session = await this.session;
    if (session) await session.harness.close(context);
  }
}
