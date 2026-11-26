import { Type } from "@earendil-works/pi-ai";
import { createHash } from 'node:crypto';
import { relative, sep } from 'node:path';
import { defineDoc, defineExtension, defineTool, type ConversationId, type Harness, type ToolExecutionApi, type Tx } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { acceptanceChecks, CheckSchema, type AcceptanceCheck, type MechanicalReport } from "./checks.js";
import type { Confirmation, TaskBrief } from "./preparation.js";
import type { CheckReceipt, CriterionResult } from "./verification.js";
import type { LearningState } from "./learning.js";
import type { SkillState } from "./skills.js";
import { outstandingDelegation, savedDelegation } from "./delegation.js";
import type { InputImage } from "./input-images.js";
import { outstandingApproval } from "./approvals.js";

export type GoalPhase = "working" | "clarifying" | "awaiting_confirmation" | "submitted" | "verifying" | "completed" | "waiting_user" | "blocked" | "needs_attention" | "failed";
export type ReviewVerdict = { verdict: "pass" | "rework" | "blocked"; reason: string; evidence: string[] };
export type GoalState = {
  initialized: boolean;
  revision: number;
  epoch: number;
  objective: string;
  userMessages: string[];
  lastUserAt?: number;
  phase: GoalPhase;
  brief?: TaskBrief;
  confirmation?: Confirmation;
  proofs?: Record<string, CheckReceipt>;
  learning?: LearningState;
  skills?: SkillState;
  localSkillReads?: { path: string; sha256: string }[];
  plan: { id: string; title: string; status: "pending" | "running" | "done"; evidence: string }[];
  checks: { source: "user" | "agent"; check: AcceptanceCheck }[];
  candidate: { id: string; revision: number; summary: string; artifacts: string[]; criteria?: CriterionResult[]; skill?: string } | null;
  review: { conversationId: ConversationId; requestId: string; candidateId: string } | null;
  mechanical: MechanicalReport | null;
  verification: { completedAt: number; reviewer: ConversationId | null; result: ReviewVerdict; method?: "checks" | "model" } | null;
  reworks: number;
  stalls: number;
  lastFingerprint: string | null;
  lastEvaluated: string | null;
  outbox: { requestId: string; content: string; images?: InputImage[] } | null;
  sharedAnswers?: Record<string, string>;
  tokenLimit: number | null;
  costLimit?: number;
  reason: string | null;
  question: string | null;
  appliedTools: Record<string, boolean>;
  events: { at: number; type: string; detail: string; revision?:number; resultHash?:string }[];
};
export const GoalDoc = defineDoc<GoalState>({
  scope: "session", kind: "local.goal", version: 1, checkpointWhen: () => true,
  initial: () => ({ initialized: false, revision: 1, epoch: 1, objective: "", userMessages: [], phase: "working", plan: [], checks: [], candidate: null,
    review: null, mechanical: null, verification: null, reworks: 0, stalls: 0, lastFingerprint: null, lastEvaluated: null, outbox: null,
    tokenLimit: 500_000, reason: null, question: null, appliedTools: {}, events: [] }),
});
export const Reviews = defineDoc<{ verdicts: Record<string, ReviewVerdict> }>({
  scope: "session", kind: "local.reviews", version: 1, initial: () => ({ verdicts: {} }), checkpointWhen: () => true,
});

/** Chord documents are proxies inside commits; detach before returning them to the host. */
export function plain<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function goalEvent(goal: GoalState, type: string, detail: string, workspace?: string): number {
  const outputs = goal.candidate?.artifacts.length
    ? [...(goal.mechanical?.files ?? []), ...(goal.mechanical?.directories ?? [])].map(file => [
      workspace ? relative(workspace, file.path).split(sep).join("/") : file.path,
      file.sha256,
    ]).sort()
    : goal.candidate?.summary;
  const at = Date.now();
  if (type === 'user_input' || type === 'confirmed') goal.lastUserAt = Math.max(goal.lastUserAt ?? 0, at);
  goal.events.push({ at, type, detail: detail.slice(0, 4000), revision:goal.revision,
    ...(type === 'completed' ? {resultHash:createHash('sha256').update(JSON.stringify(outputs ?? null)).digest('hex')} : {}) });
  if (goal.events.length > 200) goal.events.splice(0, goal.events.length - 200);
  return at;
}

export const remoteProgressKind = "local.goal.remote_progress";
const remoteProgressLabels: Readonly<Record<string, string>> = {
  created: "Task created", clarifying: "More information requested", awaiting_confirmation: "Confirmation requested",
  confirmed: "Task confirmed", plan: "Plan updated", checkpoint: "Step updated", waiting_user: "More information requested",
  child_waiting_input: "Child task needs an answer",
  user_input: "Task information received", submitted: "Result submitted for checks", verifying: "Verification started",
  rejected: "Result needs revision", completed: "Task completed", blocked: "Task blocked", needs_attention: "Needs attention",
  failed: "Task failed", budget_limited: "Budget limit reached", resumed: "Task resumed",
};
export function remoteProgressLabel(event: string): string | undefined {
  if (Object.hasOwn(remoteProgressLabels, event)) return remoteProgressLabels[event];
}

export type GoalChange<T> = (goal: GoalState, record: (type: string, detail: string, workspace?: string) => void, tx: Tx) => T | Promise<T>;

export async function changeGoal<T>(tx: Tx, change: GoalChange<T>, remoteConversation?: ConversationId): Promise<T> {
  const goal = await tx.doc(GoalDoc);
  const events: { event: string; timestamp: number }[] = [];
  const result = await change(goal, (event, detail, workspace) => {
    const timestamp = goalEvent(goal, event, detail, workspace);
    if (remoteConversation && remoteProgressLabel(event)) events.push({ event, timestamp });
  }, tx);
  if (remoteConversation) for (const data of events) {
    // The mobile history carries stable stage names without the local event's free-form detail.
    await tx.appendEntry(remoteConversation, { kind: remoteProgressKind, data });
  }
  return result;
}
export async function readGoal(harness: Harness): Promise<GoalState> {
  return harness.commit(async tx => plain(await tx.doc(GoalDoc)), ctx);
}

export function goalExtension(options: { advisoryPlan?: boolean; captureSkill?: boolean; remote?: boolean } = {}) {
  const mutate = async (api: ToolExecutionApi, context: typeof ctx, action: GoalChange<void>, submitting = false) => api.commit(tx => changeGoal(tx, async (goal, record) => {
    const key = String(api.taskId);
    if (!goal.appliedTools[key]) {
      if (goal.phase !== "working") throw new Error(`Goal is ${goal.phase}; wait for supervision or user input`);
      if (submitting && await outstandingDelegation(tx, api.conversationId, goal)) {
        throw new Error("Background delegation has not returned. End this turn when your independent work is done.");
      }
      if (submitting && await outstandingApproval(tx, api.conversationId)) throw new Error('An action approval is still outstanding. Wait for its result before submitting.');
      await action(goal, record, tx);
      goal.appliedTools[key] = true;
    }
    return { ok: true, revision: goal.revision, phase: goal.phase, candidateId: goal.candidate?.id ?? null };
  }, options.remote ? api.conversationId : undefined), context);
  const output = (value: unknown) => [{ type: "text" as const, text: JSON.stringify(value) }];
  return defineExtension({ name: "local_goal", tools: [
    defineTool({
      name: "task_status", description: "Read the durable objective, full user requirements, unfinished steps and recent failures after compaction or restart. Set details=true for the exact brief, acceptance criteria, checks and saved evidence. Use proofId for a full command receipt. Use delegation='list' for your child IDs and statuses, or pass one child conversation ID to read its saved result.",
      parameters: Type.Object({ details: Type.Optional(Type.Boolean()), proofId: Type.Optional(Type.String({ minLength: 1 })),
        delegation: Type.Optional(Type.Union([Type.Literal("list"), Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })])) }), replay: "safe", executionMode: "sequential",
      execute: async (args, api, context) => {
        if (args.delegation) return { output: output(await savedDelegation(api, args.delegation, context)) };
        return { output: output(await api.commit(async tx => {
          const goal = await tx.doc(GoalDoc);
          const failures = goal.mechanical?.results.filter(result => !result.passed) ?? [];
          const proofs = args.proofId ? { [args.proofId]: goal.proofs?.[args.proofId] ?? null } :
            Object.fromEntries(Object.values(goal.proofs ?? {}).map(p => [p.id, { passed: p.passed, exitCode: p.exitCode, command: p.command.slice(0, 120), inputs: p.inputs.length, outputs: p.outputs.length }]));
          const current = { objective: goal.objective, revision: goal.revision, userRequirements: goal.userMessages, phase: goal.phase,
            reason: goal.reason, question: goal.question, tokenLimit: goal.tokenLimit, costLimit: goal.costLimit ?? null, proofs };
          if (args.details) return plain({ ...current, brief: goal.brief ?? null, confirmation: goal.confirmation ?? null,
            ...(goal.learning ? { learning: goal.learning } : {}), ...(goal.skills ? { skills: goal.skills } : {}),
            plan: goal.plan, checks: goal.checks, candidate: goal.candidate, verification: goal.verification,
            reworks: goal.reworks, stalls: goal.stalls, failedChecks: failures });
          const brief = goal.brief ? { revision: goal.brief.revision, outcomePreview: goal.brief.outcome.slice(0, 200),
            criteria: goal.brief.criteria.map((criterion, i) => ({ id: i + 1, method: criterion.method, preview: criterion.text.slice(0, 200) })) } : null;
          return plain({ ...current, brief, confirmed: !!goal.confirmation,
            ...(goal.learning ? { learning: { offers: goal.learning.offers } } : {}),
            ...(goal.skills ? { skills: { pins: goal.skills.pins, loaded: goal.skills.loaded } } : {}),
            plan: goal.plan.filter(step => step.status !== "done").map(({ id, title, status }) => ({ id, title, status })),
            checkCount: goal.checks.length, failedChecksCount: failures.length,
            failedChecks: failures.slice(0, 6).map(({ label, passed, detail }) => ({ label: label.slice(0, 240), passed, detail: detail.slice(0, 350) })) });
        }, context)) };
      },
    }),
    defineTool({
      name: "task_plan", description: `${options.advisoryPlan ? "Optionally record a concise plan for progress. Plan status does not gate delivery. " : ""}Persist a plan with stable step IDs; retain completed steps. Optionally APPEND mechanical file checks. Existing checks cannot be removed or weakened. Only mark steps done through task_checkpoint with evidence.`,
      parameters: Type.Object({ steps: Type.Array(Type.Object({ id: Type.String({ minLength: 1, maxLength: 64 }), title: Type.String({ minLength: 1, maxLength: 500 }) }), { minItems: 1, maxItems: 24 }),
        checks: Type.Optional(Type.Array(CheckSchema, { maxItems: 32 })) }), replay: "safe", executionMode: "sequential",
      execute: async (args, api, context) => ({ output: output(await mutate(api, context, (goal, record) => {
        if (new Set(args.steps.map(s => s.id)).size !== args.steps.length) throw new Error("Plan step IDs must be unique");
        const added = acceptanceChecks(args.checks);
        const checks = plain(goal.checks);
        for (const check of added) if (!checks.some(c => JSON.stringify(c.check) === JSON.stringify(check))) checks.push({ source: "agent", check });
        if (checks.length > 32) throw new Error("At most 32 acceptance checks per task");
        const previous = plain(goal.plan);
        goal.plan = args.steps.map(step => ({ id: step.id, status: "pending" as const, evidence: "", ...previous.find(s => s.id === step.id), title: step.title }));
        for (const step of previous) if (step.status === "done" && !goal.plan.some(s => s.id === step.id)) goal.plan.push(step);
        goal.checks = checks;
        record("plan", `${goal.plan.length} steps, ${goal.checks.length} checks`);
      })) }),
    }),
    defineTool({
      name: "task_checkpoint", description: "Persist a plan step's state and concrete evidence. Notes alone do not prove task completion.",
      parameters: Type.Object({ stepId: Type.String(), status: Type.Union([Type.Literal("pending"), Type.Literal("running"), Type.Literal("done")]), evidence: Type.String({ minLength: 1, maxLength: 2000 }) }), replay: "safe", executionMode: "sequential",
      execute: async (args, api, context) => ({ output: output(await mutate(api, context, (goal, record) => {
        const step = goal.plan.find(s => s.id === args.stepId);
        if (!step) throw new Error("Unknown plan step ID");
        step.status = args.status; step.evidence = args.evidence;
        record("checkpoint", `${step.id}: ${step.status}: ${step.evidence}`);
      })) }),
    }),
    defineTool({
      name: "task_submit", description: `Submit a candidate for task verification and end this run. This does NOT mark the task completed. Include the actual artifacts; ${options.advisoryPlan ? "report actual checks and unresolved requirements, without registering optional plan checkpoints just to submit" : "finish any plan checkpoints first"}. For a confirmed brief cover every criterion (1-based ID) with status, concrete evidence and current task_verify proof IDs for command checks. For a text-only request submit its answer in summary and an empty artifacts array.`,
      parameters: Type.Object({ summary: Type.String({ minLength: 1, maxLength: 16000 }), artifacts: Type.Array(Type.String({ minLength: 1, maxLength: 2048 }), { maxItems: 32 }),
        ...(options.captureSkill ? { skill: Type.Optional(Type.String({ minLength: 1, maxLength: 2048, description: "Optional standard Skill directory already included in freshly verified outputs. No extra learning task; skip if no useful reusable discovery." })) } : {}),
        criteria: Type.Optional(Type.Array(Type.Object({ id: Type.Integer({ minimum: 1, maximum: 16 }), status: Type.Union([Type.Literal("passed"), Type.Literal("failed"), Type.Literal("unverified")]),
          evidence: Type.String({ minLength: 1, maxLength: 2000 }), proofIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 8 })) }), { maxItems: 16 })) }), replay: "safe", executionMode: "sequential",
      execute: async (args, api, context) => ({ output: output(await mutate(api, context, (goal, record) => {
        if (args.criteria && new Set(args.criteria.map(c => c.id)).size !== args.criteria.length) throw new Error("Criterion IDs must be unique");
        goal.candidate = { id: String(api.taskId), revision: goal.revision, summary: args.summary, artifacts: [...new Set(args.artifacts)], ...(args.criteria ? { criteria: args.criteria } : {}) };
        if (options.captureSkill && "skill" in args && typeof args.skill === "string") goal.candidate.skill = args.skill;
        goal.phase = "submitted"; goal.review = null; goal.mechanical = null; goal.verification = null;
        record("submitted", args.summary);
      }, true)), control: { terminate: true } }),
    }),
    defineTool({
      name: "task_blocked", description: "Stop autonomous work when an external dependency is unavailable. If user input is required, provide a precise question. State what is already done and why continuation is impossible.",
      parameters: Type.Object({ reason: Type.String({ minLength: 1, maxLength: 4000 }), question: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })) }), replay: "safe", executionMode: "sequential",
      execute: async (args, api, context) => ({ output: output(await mutate(api, context, (goal, record) => {
        goal.phase = args.question ? "waiting_user" : "blocked"; goal.reason = args.reason; goal.question = args.question ?? null;
        record(goal.phase, `${args.reason}${args.question ? `\n${args.question}` : ""}`);
      })), control: { terminate: true } }),
    }),
  ] });
}

/** Installed only in the isolated reviewer, never in the coordinator or its workers. */
export function reviewExtension() {
  return defineExtension({ name: "local_review", tools: [defineTool({
    name: "review_result", description: "Submit an independent acceptance verdict. Read artifacts and compare the ORIGINAL objective and user requirements. Reject missing requirements, incorrect calculations and unsupported completion claims. Evidence should cite inspected paths/findings. Ends review.",
    parameters: Type.Object({ verdict: Type.Union([Type.Literal("pass"), Type.Literal("rework"), Type.Literal("blocked")]), reason: Type.String({ minLength: 1, maxLength: 4000 }), evidence: Type.Array(Type.String({ maxLength: 2000 }), { maxItems: 32 }) }),
    replay: "safe", executionMode: "sequential",
    execute: async (args, api, context) => {
      await api.commit(async tx => { const reviews = await tx.doc(Reviews); reviews.verdicts[String(api.conversationId)] = args; }, context);
      return { output: [{ type: "text", text: JSON.stringify(args) }], control: { terminate: true } };
    },
  })] });
}
