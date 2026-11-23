import type { TaskStatus } from "./client.js";
import { verificationText } from "./presentation.js";
import { conversationAnswer } from "./conversation.js";

/** A delivery-oriented projection; no transcript, tool output or independent task state. */
export function taskView(status: TaskStatus) {
  const goal = status.goal;
  const message = status.interaction === "chat" ? [...status.messages].reverse().find(m => conversationAnswer(m) !== undefined) : undefined;
  return {
    id: status.id, objective: status.objective, workspace: status.workspace, status: status.status,
    interaction: status.interaction,
    reply: message ? { timestamp: message.timestamp, text: conversationAnswer(message)! } : null,
    brief: goal?.brief ?? null, briefDigest: status.briefDigest,
    confirmed: Boolean(goal?.confirmation), question: goal?.question ?? null, reason: goal?.reason ?? status.initializationError ?? null,
    budget: { estimatedCostUsd: status.budget.estimatedCostUsd, costLimit: status.budget.costLimit,priceKnown:status.budget.priceKnown,totalTokens:status.budget.totalTokens },
    resumeBudget: status.resumeBudget,
    progress: { steps: goal?.plan ?? [], tools: status.activeTools },
    delegations:status.delegations,
    delivery: status.status === "completed" && goal?.candidate ? {
      summary: goal.candidate.summary, artifacts: goal.candidate.artifacts,
      verification: verificationText(status), assumptions: goal.brief?.assumptions ?? [],
    } : null,
  };
}

export type TaskView = ReturnType<typeof taskView>;

export function taskHandoff(status:TaskStatus) {
  const goal = status.goal;
  const group = ['waiting_user','blocked','needs_attention','clarifying','awaiting_confirmation','failed','paused','budget_limited'].includes(status.status) ? 'pending'
    : ['completed','answered'].includes(status.status) ? 'delivered' : status.status === 'cancelled' ? 'closed' : 'running';
  const step = goal?.plan.find(step => step.status === 'running')?.title;
  const summary = group === 'pending' ? goal?.question ?? goal?.reason ?? (status.status === 'awaiting_confirmation' ? '等待确认任务说明和预算' : status.status)
    : goal?.candidate?.summary ?? step ?? (status.interaction === 'chat' ? '普通对话' : '执行目标');
  return {group,summary:summary.slice(0,2000),question:goal?.question ?? null,step:step ?? null,
    budget:{totalTokens:status.budget.totalTokens,estimatedCostUsd:status.budget.priceKnown ? status.budget.estimatedCostUsd : null,costLimit:status.budget.costLimit},
    artifacts:status.status === 'completed' ? goal?.candidate?.artifacts ?? [] : []};
}
