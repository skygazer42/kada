import { createHash } from 'node:crypto';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { boundOutput } from '@earendil-works/chord/output';
import { defineDoc, defineExtension, defineTask, LiveDoc, type ConversationId, type Harness, type JsonObject, type TaskId, type ToolExecutionApi, type ToolExecutionResult, type Tx } from '@earendil-works/pi-durable';
import { changeGoal, GoalDoc, plain } from './goal.js';
import type { McpPin, McpTools } from './mcp-tools.js';

type Approval = {
  id: string; revision: number; epoch: number; pin: Pick<McpPin, 'id' | 'revision' | 'tools'>; tool: string; arguments: JsonObject; digest: string;
  createdAt: number; expiresAt: number; status: 'pending' | 'allowed' | 'denied' | 'dispatching' | 'completed' | 'uncertain' | 'expired' | 'stale';
  decision?: 'allow' | 'deny'; executor?: TaskId<null>; result?: string;
  images?: { type: 'image'; data: string; mimeType: string }[];
};
export const ApprovalDoc = defineDoc<{ requests: Record<string, Approval> }>({
  scope: 'session', kind: 'local.action_approvals', version: 1, initial: () => ({ requests: {} }), checkpointWhen: () => true,
});
export class ApprovalError extends Error { constructor(readonly status: number, message: string) { super(message); } }

function preview(value: unknown, key = ''): unknown {
  if (/secret|token|password|authorization|credential|(?:api|private|access).?key|cookie/i.test(key)) return '[credential withheld]';
  if (typeof value === 'string') return value.replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|Bearer\s+\S+)|https?:\/\/[^\s/@]+:[^\s/@]+@/gi, '[credential withheld]');
  if (Array.isArray(value)) return value.map(item => preview(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, preview(item, name)]));
  return value;
}

export async function approvalViews(harness: Harness) {
  const state = await harness.snapshot(ApprovalDoc, context);
  return Object.values(state?.requests ?? {}).map(request => ({ id: request.id, connection: request.pin.id,
    connectionRevision: request.pin.revision, tool: request.tool, arguments: preview(request.arguments), digest: request.digest,
    createdAt: request.createdAt, expiresAt: request.expiresAt,
    status: request.status === 'pending' && Date.now() >= request.expiresAt ? 'expired' as const : request.status, decision: request.decision,
    result: request.result }));
}

export async function outstandingApproval(tx: Tx, parent: ConversationId) {
  const { requests } = await tx.doc(ApprovalDoc);
  const goal = await tx.doc(GoalDoc);
  for (const request of Object.values(requests)) {
    if (request.revision !== goal.revision || request.epoch !== goal.epoch) continue;
    if (['pending', 'allowed', 'dispatching'].includes(request.status)) return true;
    if (request.decision) {
      const report = await tx.submissionByRequest(parent, 'approval-report:' + request.id);
      if (!report || report.status === 'queued') return true;
    }
  }
  return false;
}

export async function approvalReport(harness: Harness, parent: Parameters<Harness['conversation']>[0]) {
  const state = await harness.snapshot(ApprovalDoc, context);
  const goal = await harness.snapshot(GoalDoc, context);
  for (const request of Object.values(state?.requests ?? {})) {
    if (request.revision !== goal?.revision || request.epoch !== goal.epoch) continue;
    if (!request.decision || request.status === 'allowed' || request.status === 'dispatching') continue;
    const requestId = 'approval-report:' + request.id;
    const reported = await harness.commit(tx => tx.submissionByRequest(parent, requestId), context);
    if (!reported) return { requestId, id: request.id, status: request.status, result: request.result ?? 'The action was denied and did not execute.', images: request.images };
  }
}

export async function stopObsoleteApprovals(harness: Harness, goal?: { revision: number; epoch: number }) {
  if (!await harness.snapshot(ApprovalDoc, context)) return;
  const stopped = await harness.commit(async tx => {
    const { requests } = await tx.doc(ApprovalDoc);
    const executors: TaskId<null>[] = [];
    for (const request of Object.values(requests)) {
      if (request.revision === goal?.revision && request.epoch === goal.epoch) continue;
      if (request.status === 'pending' || request.status === 'allowed') {
        request.status = 'stale'; request.result = 'The task changed before this action was dispatched.';
      } else if (request.status === 'dispatching') {
        request.status = 'uncertain'; request.result = 'The task changed during execution. Inspect the action’s actual effect.';
      }
      if (request.executor) {
        const executor = await tx.task(request.executor);
        if (executor && executor.state.status !== 'terminal') executors.push(request.executor);
      }
    }
    return executors;
  }, context);
  for (const executor of stopped) await harness.abortTask(executor, context);
}

export async function decideApproval(harness: Harness, mcp: McpTools, id: string, decision: 'allow' | 'deny', digest: string, deadline: number) {
  if (!/^\d+$/.test(id) || !['allow', 'deny'].includes(decision) || !/^[a-f0-9]{64}$/.test(digest)) throw new ApprovalError(400, 'Provide the approval ID, decision and displayed digest.');
  const saved = (await harness.snapshot(ApprovalDoc, context))?.requests[id];
  if (!saved) throw new ApprovalError(404, 'Action approval not found.');
  if (saved.digest !== digest || saved.decision && saved.decision !== decision) throw new ApprovalError(409, 'The displayed action or decision does not match this approval.');
  if (saved.decision) return { id, decision };
  if (decision === 'allow') await mcp.requiresApproval(saved.pin, saved.tool);
  const executor = approvalExtension(mcp).execute;
  const root = await harness.root(context);
  return harness.commit(async tx => {
    const request = (await tx.doc(ApprovalDoc)).requests[id];
    if (!request || request.digest !== digest) throw new ApprovalError(409, 'The displayed action does not match this approval.');
    if (request.decision) {
      if (request.decision !== decision) throw new ApprovalError(409, 'This action already has a different decision.');
      return { id, decision };
    }
    const goal = await tx.doc(GoalDoc);
    if (request.status !== 'pending' || (decision === 'allow' && Date.now() >= request.expiresAt) || goal.revision !== request.revision || goal.epoch !== request.epoch || goal.phase !== 'waiting_user') {
      throw new ApprovalError(409, 'The action expired or the task changed.');
    }
    request.decision = decision;
    request.status = decision === 'allow' ? 'allowed' : 'denied';
    if (decision === 'allow') request.executor = await tx.createTask(executor, { id, deadline }, { ownership: { kind: 'conversation' }, conversationId: root.id });
    await changeGoal(tx, (state, record) => {
      state.phase = 'working'; state.reason = null; state.question = null;
      record('approval_decided', `Action ${id} ${decision === 'allow' ? 'allowed once' : 'denied'}.`);
    });
    return { id, decision };
  }, context);
}

export async function requestApproval(pin: McpPin, tool: string, args: Record<string, unknown>, api: ToolExecutionApi, ctx: typeof context): Promise<ToolExecutionResult> {
  const receipt = await api.commit(async tx => {
    const goal = await tx.doc(GoalDoc);
    if ((await tx.conversation(api.conversationId))?.owner) throw new Error('Only the main task can request host action approvals.');
    const { requests } = await tx.doc(ApprovalDoc);
    const id = String(api.taskId);
    const prior = requests[id];
    if (prior) return { id, digest: prior.digest };
    const live = await tx.doc(LiveDoc, api.conversationId);
    if (live.tools?.length !== 1 || live.tools[0]?.taskId !== api.taskId) {
      throw new Error('Call this approval-required MCP tool by itself in a new tool round.');
    }
    if (goal.phase !== 'working' || !goal.initialized) throw new Error('An approved execution goal is required for this action.');
    if (Object.values(requests).some(request => request.revision === goal.revision && request.epoch === goal.epoch &&
      ['pending', 'allowed', 'dispatching'].includes(request.status))) throw new Error('Review the outstanding action before requesting another.');
    const arguments_ = JSON.parse(JSON.stringify(args)) as JsonObject;
    if (Buffer.byteLength(JSON.stringify(arguments_)) > 32_000) throw new Error('The approval parameters exceed 32 KiB.');
    const createdAt = api.now();
    const digest = createHash('sha256').update(JSON.stringify([pin.id, pin.revision, tool, arguments_, goal.revision, goal.epoch])).digest('hex');
    requests[id] = { id, revision: goal.revision, epoch: goal.epoch, pin: { id: pin.id, revision: pin.revision, tools: [...pin.tools] }, tool, arguments: arguments_, digest,
      createdAt, expiresAt: createdAt + 10 * 60_000, status: 'pending' };
    await changeGoal(tx, (state, record) => {
      state.phase = 'waiting_user'; state.reason = 'A tool action needs approval.';
      state.question = `Review MCP action ${pin.id}/${tool} with /approvals, then /allow ${id} or /deny ${id}.`;
      record('waiting_user', state.question);
    });
    return { id, digest };
  }, ctx);
  return { output: [{ type: 'text', text: JSON.stringify({ approval: receipt, message: 'Action saved for user approval. It has not executed.' }) }], control: { terminate: true } };
}

export function approvalExtension(mcp: McpTools) {
  const execute = defineTask<{ id: string; deadline: number }, { phase: 'execute' }, null>({
    name: 'local.approval.execute', version: 1, initial: () => ({ phase: 'execute' }),
    phases: { execute: async (task, runtime, ctx) => {
      let action: Approval | undefined;
      await runtime.commit(async tx => {
        const { requests } = await tx.doc(ApprovalDoc);
        const request = requests[task.input.id];
        if (!request || request.executor !== task.id) return { status: 'terminal', outcome: { status: 'completed', result: null } };
        if (request.status === 'dispatching') {
          request.status = 'uncertain'; request.result = 'The action was interrupted after dispatch intent. Inspect its actual effect before any retry.';
          return { status: 'terminal', outcome: { status: 'completed', result: null } };
        }
        if (request.status !== 'allowed') return { status: 'terminal', outcome: { status: 'completed', result: null } };
        const goal = await tx.doc(GoalDoc);
        const expired = runtime.now() >= Math.min(request.expiresAt, task.input.deadline);
        if (goal.revision !== request.revision || goal.epoch !== request.epoch || goal.phase !== 'working' || expired) {
          request.status = expired ? 'expired' : 'stale';
          request.result = 'The approved action expired or belongs to an earlier goal.';
          return { status: 'terminal', outcome: { status: 'completed', result: null } };
        }
        action = plain(request);
      }, ctx);
      if (!action) return;
      let result: string;
      let images: Approval['images'];
      let status: Approval['status'];
      let dispatched = false;
      const expiresAt = Math.min(action.expiresAt, task.input.deadline);
      try {
        const response = await mcp.executeApproved(action.pin, action.tool, action.arguments, runtime.signal, async () => {
          await runtime.commit(async tx => {
            const request = (await tx.doc(ApprovalDoc)).requests[task.input.id];
            const goal = await tx.doc(GoalDoc);
            if (!request || request.status !== 'allowed' || goal.revision !== request.revision ||
              goal.epoch !== request.epoch || goal.phase !== 'working' || runtime.now() >= expiresAt) {
              throw new Error('The approval expired or the task changed before dispatch.');
            }
            request.status = 'dispatching';
          }, ctx);
          if (runtime.now() >= expiresAt) throw new Error('The approval expired before dispatch.');
          runtime.signal.throwIfAborted();
          dispatched = true;
        });
        const text = (response.output ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n');
        const bounded = boundOutput(text, { maxBytes: 48_000, maxLines: 2000, retain: 'head' });
        images = (response.output ?? []).filter(block => block.type === 'image')
          .filter(block => block.data.length <= 4.5 * 1024 * 1024).slice(0, 4);
        result = JSON.stringify({ isError: response.isError === true, text: bounded.text,
          ...(bounded.droppedBytes ? { omittedBytes: bounded.droppedBytes } : {}) });
        status = 'completed';
      } catch {
        if (runtime.signal.aborted) return;
        status = dispatched ? 'uncertain' : runtime.now() >= expiresAt ? 'expired' : 'stale';
        result = dispatched ? 'The tool call did not return a confirmed result. Inspect its effect and connection before retrying.'
          : 'The action stopped before dispatch. Check the approval deadline, task and MCP connection.';
      }
      await runtime.commit(async tx => {
        const request = (await tx.doc(ApprovalDoc)).requests[task.input.id];
        if (request?.status === 'allowed' || request?.status === 'dispatching') {
          request.status = status; request.result = result;
          if (images?.length) request.images = images;
        }
        return { status: 'terminal', outcome: { status: 'completed', result: null } };
      }, ctx);
    } },
    abort: async (task, runtime, ctx) => runtime.commit(async tx => {
      const request = (await tx.doc(ApprovalDoc)).requests[task.input.id];
      if (request?.status === 'dispatching') { request.status = 'uncertain'; request.result = 'The action was interrupted. Inspect its actual effect before retrying.'; }
      else if (request?.status === 'allowed') { request.status = 'stale'; request.result = 'The action was stopped before dispatch.'; }
      return { status: 'terminal', outcome: { status: 'aborted' } };
    }, ctx),
  });
  return { execute, extension: defineExtension({ name: 'local_approvals', tasks: [execute] }) };
}
