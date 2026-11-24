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

export { nextRoutineTime, type RoutineSchedule } from "./routine-schedule.js";

export type RoutineBudget = {
  maxEstimatedCostUsd: number;
  maxDurationMs: number;
  maxTotalTokens?: number;
};

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
  precheck?: { command: string[] };
};

type RoutineDefinition = Omit<RoutineInput, "id" | "acceptance" | "missedPolicy" | "budgetPolicy" | "notifyOnChange"> & {
  acceptance: AcceptanceCheck[];
  missedPolicy: NonNullable<RoutineInput["missedPolicy"]>;
  budgetPolicy: NonNullable<RoutineInput["budgetPolicy"]>;
  notifyOnChange: boolean;
};

export type RoutineOccurrence = Omit<RoutineDefinition, "schedule" | "missedPolicy" | "overlapPolicy"> & {
  id: string;
  routineId: string;
  revision: number;
  scheduledAt: string;
  taskId: string;
  timing?: RoutineTiming;
};

export type RoutineExecution =
  | { status?: "started"; taskId: string }
  | { status: "notified" | "budget_exhausted" };

type PrecheckResult =
  | { status: "changed" | "unchanged"; sha256: string }
  | { status: "failed" | "interrupted"; detail: string };

type TaskOverview = Awaited<ReturnType<LocalRuntime["taskOverview"]>>;
type TaskState = TaskOverview["status"];
type StartedOccurrence = { occurrenceId: string; taskId: string };

type Receipt = Pick<RoutineOccurrence, "id" | "scheduledAt"> & {
  status: "claimed" | "notified" | "started" | "budget_exhausted" | "skipped" | "failed";
  taskId?: string;
  timing?: RoutineTiming;
  precheck?: PrecheckResult;
  blockedBy?: StartedOccurrence & { status: TaskState };
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

type StoredRoutine = Routine & {
  timerId?: Parameters<Harness["abortTask"]>[0];
  claim?: RoutineOccurrence & { precheckResult?: PrecheckResult };
  lastPrecheckSha256?: string;
  lastStarted?: StartedOccurrence;
};

export interface LocalRoutineOptions {
  dataDir: string;
  execute(occurrence: RoutineOccurrence, signal: AbortSignal): Promise<RoutineExecution>;
  taskOverview?(taskId: string): Promise<TaskOverview | undefined>;
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

type TimerInput = { routineId: string; revision: number; firstAt: number };
type TimerCheckpoint = { phase: "wait"; at: number } | { phase: "deliver"; at: number };
type Session = { harness: Harness; conversationId: ConversationId; timer: ReturnType<typeof makeTimer> };
const completed = { status: "terminal", outcome: { status: "completed", result: null } } as const;
const context = BACKGROUND_CONTEXT;
const keyFor = (id: string) => "routine:" + id;

function snapshot<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
}

function toRoutine({ timerId: _timer, claim: _claim, lastPrecheckSha256: _baseline, lastStarted: _lastStarted, ...routine }: StoredRoutine): Routine {
  const nextTiming=routine.nextRunAt ? routineTiming(routine.schedule,Date.parse(routine.nextRunAt)) : undefined;
  return { ...routine, notifyOnChange: routine.notifyOnChange ?? false,...(nextTiming ? {nextTiming} : {}) };
}

function inputId(value: string | undefined): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,120}$/.test(value)) {
    throw new RoutineError(400, "A routine ID must contain 1 to 120 letters, digits, hyphens, or underscores.");
  }
  return value;
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
  const precheck = input.precheck;
  if (precheck !== undefined && (!precheck || input.action !== "task" || !input.workspace ||
    !Array.isArray(precheck.command) || precheck.command.length > 64 ||
    typeof precheck.command[0] !== "string" || !precheck.command[0].trim() ||
    precheck.command.some(arg => typeof arg !== "string" || arg.includes("\0")) || precheck.command.join("").length > 16_000)) {
    throw new RoutineError(400, "A precheck requires a task workspace and a command argument array.");
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
    ...(precheck ? { precheck: { command: [...precheck.command] } } : {}),
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
  const at = schedule.kind === "once" ? Date.parse(schedule.at) : nextRoutineTime(schedule, now)!;
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

function occurrenceFor(rule: StoredRoutine, at: number): RoutineOccurrence {
  const scheduledAt = new Date(at).toISOString();
  const id = [rule.id, rule.revision, scheduledAt].join("/");
  const taskId=taskIdFor(id);
  const { action, objective, workspace, acceptance, budget, budgetPolicy, notifyOnChange, precheck } = rule;
  const timing=routineTiming(rule.schedule,at);
  return {
    id, routineId: rule.id, revision: rule.revision, scheduledAt, taskId, action, objective, acceptance, budgetPolicy,
    notifyOnChange: notifyOnChange ?? false,
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

function advance(rule: StoredRoutine, receipt: Receipt, now: number) {
  const saved = { ...rule, lastOccurrence: receipt };
  if (rule.overlapPolicy === "skip" && receipt.status === "started" && receipt.taskId) {
    saved.lastStarted = { occurrenceId: receipt.id, taskId: receipt.taskId };
  }
  if (receipt.status === "started" && receipt.precheck?.status === "changed") saved.lastPrecheckSha256 = receipt.precheck.sha256;
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

async function samplePrecheck(workspace: string, command: string[], ctx: typeof context) {
  const output = createHash("sha256");
  const result = await localEnvironment(workspace).exec(command, {
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
    initial: (input) => ({ phase: "wait", at: input.firstAt }),
    phases: {
      wait: (task, runtime, ctx) => {
        const at = task.state.checkpoint.at;
        return runtime.sleepUntil(at, { phase: "deliver", at }, ctx);
      },
      deliver: async (task, runtime, ctx) => {
        const { routineId, revision } = task.input;
        const key = keyFor(routineId);
        let occurrence: RoutineOccurrence | undefined;
        let precheck: PrecheckResult | undefined;
        let newClaim = false;
        let previousTaskId: string | undefined;
        const claimDue = (checked?: { status: TaskState | undefined }) => runtime.commit(async (tx) => {
          const { rules } = await tx.doc(routinesDoc);
          const rule = snapshot(rules[key]);
          if (!rule || rule.revision !== revision || rule.status !== "scheduled") return completed;
          if (rule.claim) {
            occurrence = { ...rule.claim, notifyOnChange: rule.claim.notifyOnChange ?? false };
            precheck = rule.claim.precheckResult;
            return;
          }
          const now = runtime.now();
          const at = task.state.checkpoint.at;
          const latest = latestRoutineTime(rule.schedule, now);
          const missed = at < openedAt || (latest !== undefined && latest > at);
          const due = occurrenceFor(rule, latest === undefined ? at : Math.max(at, latest));
          const skipMissed = missed && rule.missedPolicy === "skip";
          let blockedBy: Receipt["blockedBy"];
          if (!skipMissed && rule.overlapPolicy === "skip" && options.taskOverview && rule.lastStarted) {
            if (!checked) {
              previousTaskId = rule.lastStarted.taskId;
              return;
            }
            const status = checked.status;
            if (status && !["completed", "answered", "cancelled", "failed", "budget_limited"].includes(status)) {
              blockedBy = { ...rule.lastStarted, status };
            }
          }
          if (skipMissed || blockedBy) {
            const skipped: Receipt = {
              id: due.id, scheduledAt: due.scheduledAt, status: "skipped",
              ...(due.timing ? { timing: due.timing } : {}), ...(blockedBy ? { blockedBy } : {}),
            };
            await recordOccurrence(tx, runtime.conversationId, rule, skipped, now);
            const advanced = advance(rule, skipped, now);
            rules[key] = advanced.rule;
            return advanced.state;
          }
          await recordOccurrence(tx,runtime.conversationId,rule,{id:due.id,scheduledAt:due.scheduledAt,status:'claimed',...(due.action==='task' ? {taskId:due.taskId} : {}),...(due.timing ? {timing:due.timing} : {})},now);
          rules[key] = { ...rule, claim: due };
          occurrence = due;
          newClaim = true;
        }, ctx);
        await claimDue();
        // Budget settlement can abort this timer before its queued task lookup runs.
        if (previousTaskId && options.taskOverview && !runtime.signal.aborted) {
          const overview = await awaitWithContext(options.taskOverview(previousTaskId), ctx);
          await claimDue({ status: overview?.status });
        }
        if (!occurrence || runtime.signal.aborted) return;

        const due = occurrence;
        const { id, scheduledAt } = due;
        if (due.precheck && newClaim) {
          const sample = await samplePrecheck(due.workspace!, due.precheck.command, ctx);
          if (runtime.signal.aborted) return;
          await runtime.commit(async (tx) => {
            const { rules } = await tx.doc(routinesDoc);
            const rule = snapshot(rules[key]);
            if (!rule || rule.revision !== revision || rule.claim?.id !== id || rule.status !== "scheduled") return completed;
            precheck = sample.sha256 === undefined ? { status: "failed", detail: sample.detail }
              : { status: sample.sha256 === rule.lastPrecheckSha256 ? "unchanged" : "changed", sha256: sample.sha256 };
            rules[key] = { ...rule, claim: { ...rule.claim, precheckResult: precheck } };
          }, ctx);
          if (!precheck || runtime.signal.aborted) return;
        } else if (due.precheck && !precheck) {
          precheck = { status: "interrupted", detail: "The prior check may have run. Inspect actual state before retrying." };
        }
        const timing=occurrence.timing ? {timing:occurrence.timing} : {};
        const evidence = { id, scheduledAt, ...timing, ...(precheck ? { precheck } : {}) };
        let receipt: Receipt;
        try {
          if (precheck && precheck.status !== "changed") {
            receipt = { ...evidence, status: precheck.status === "unchanged" ? "skipped" : "failed" };
          } else {
            const result = await options.execute(due, runtime.signal);
            receipt = { ...evidence, status: result.status ?? "started", ...("taskId" in result ? { taskId: result.taskId } : {}) };
          }
        } catch {
          receipt = { ...evidence, status: "failed" };
        }
        if (runtime.signal.aborted) return;

        await runtime.commit(async (tx) => {
          const { rules } = await tx.doc(routinesDoc);
          const rule = snapshot(rules[key]);
          if (!rule || rule.revision !== revision || rule.claim?.id !== id || rule.status !== "scheduled") return completed;
          const known = rule.lastOccurrence;
          if(known?.id!==id || known.status!=='budget_exhausted') await recordOccurrence(tx,runtime.conversationId,rule,receipt,runtime.now());
          const advanced = advance(rule, known?.id === id && known.status === "budget_exhausted" ? known : receipt, runtime.now());
          rules[key] = advanced.rule;
          return advanced.state;
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
    const root = await harness.root(context);
    return { harness, conversationId: root.id, timer };
  }

  async create(input: RoutineInput): Promise<Routine> {
    const details = definition(input);
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
      const firstAt = firstTime(details.schedule, this.now());
      const timerId = await tx.createTask(timer, { routineId: id, revision: 1, firstAt }, {
        ownership: { kind: "conversation" }, conversationId,
      });
      const next = { ...details, id, revision: 1, status: "scheduled", nextRunAt: new Date(firstAt).toISOString(), timerId } as const;
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
      const firstAt = firstTime(details.schedule, this.now());
      const timerId = await tx.createTask(timer, { routineId: id, revision, firstAt }, {
        ownership: { kind: "conversation" }, conversationId,
      });
      const next: StoredRoutine = {
        ...details, id, revision, status: "scheduled", nextRunAt: new Date(firstAt).toISOString(), timerId,
        ...(previous.lastOccurrence ? { lastOccurrence: previous.lastOccurrence } : {}),
      };
      rules[key] = next;
      return { routine: toRoutine(next), previousTimer: previous.timerId };
    }, context);
    if (result.previousTimer) await harness.abortTask(result.previousTimer, context);
    harness.resume();
    return result.routine;
  }

  async cancel(id: string): Promise<Routine> {
    const key = keyFor(inputId(id));
    const { harness } = await this.open();
    const result = await harness.commit(async (tx) => {
      const { rules } = await tx.doc(routinesDoc);
      const previous = snapshot(rules[key]);
      if (!previous) throw new RoutineError(404, "Routine not found.");
      if (previous.status === "cancelled") return { routine: toRoutine(previous) };
      const next = endSchedule(previous, "cancelled");
      rules[key] = next;
      return { routine: toRoutine(next), previousTimer: previous.timerId };
    }, context);
    if (result.previousTimer) await harness.abortTask(result.previousTimer, context);
    harness.resume();
    return result.routine;
  }

  async settleBudget(occurrenceId: string): Promise<void> {
    const [id, revision, scheduledAt, extra] = occurrenceId.split("/");
    if (!id || !revision || !scheduledAt || extra !== undefined || !Number.isFinite(Date.parse(scheduledAt))) return;
    const key = keyFor(id);
    const { harness,conversationId } = await this.open();
    const previousTimer = await harness.commit(async (tx) => {
      const { rules } = await tx.doc(routinesDoc);
      const rule = snapshot(rules[key]);
      const known=await recordedOccurrence(tx,conversationId,occurrenceId);
      if(known.budgetRecorded) return;
      let origin=known.record;
      if(!origin && rule && String(rule.revision)===revision && rule.action==='task' && (rule.claim?.id===occurrenceId || rule.lastOccurrence?.id===occurrenceId)) {
        const occurrence=occurrenceFor(rule,Date.parse(scheduledAt));
        origin={id:occurrenceId,scheduledAt,status:'claimed',taskId:occurrence.taskId,...(occurrence.timing ? {timing:occurrence.timing} : {}),routineId:rule.id,revision:rule.revision,action:rule.action,objective:rule.objective,missedPolicy:rule.missedPolicy,budgetPolicy:rule.budgetPolicy,...(rule.budget ? {budget:rule.budget} : {}),recordedAt:this.now()};
      }
      if(!origin || origin.action!=='task') return;
      const precheck = origin.precheck ?? (rule?.claim?.id === occurrenceId ? rule.claim.precheckResult : undefined);
      const lastOccurrence:Receipt={id:occurrenceId,scheduledAt,status:'budget_exhausted',taskId:origin.taskId ?? taskIdFor(occurrenceId),...(origin.timing ? {timing:origin.timing} : {}),...(precheck ? {precheck} : {})};
      await tx.appendEntry(conversationId,{kind:occurrenceEntryKind,data:{...origin,...lastOccurrence,recordedAt:this.now()}});
      if(!rule || String(rule.revision)!==revision || rule.action!=='task' || rule.status==='cancelled') return;
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
