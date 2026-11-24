import type { TaskStatus } from "./client.js";
import { skillRecords, verificationText } from "./presentation.js";
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
    consumption: {
      inputTokens: status.budget.inputTokens, cachedTokens: status.budget.cachedTokens,
      cacheWriteTokens: status.budget.cacheWriteTokens, outputTokens: status.budget.outputTokens,
      compactions: status.compactions, reworks: goal?.reworks ?? 0,
    },
    resumeBudget: status.resumeBudget,
    progress: { steps: goal?.plan ?? [], tools: status.activeTools },
    skills: skillRecords(status),
    delegations:status.delegations,
    delivery: status.status === "completed" && goal?.candidate ? {
      summary: goal.candidate.summary, artifacts: goal.candidate.artifacts,
      verification: verificationText(status), assumptions: goal.brief?.assumptions ?? [],
    } : null,
  };
}

export type TaskView = ReturnType<typeof taskView>;

export function taskGroup(status: TaskStatus['status']) {
  return ['waiting_user','blocked','needs_attention','clarifying','awaiting_confirmation','failed','paused','budget_limited'].includes(status) ? 'pending'
    : ['completed','answered'].includes(status) ? 'delivered' : status === 'cancelled' ? 'closed' : 'running';
}

export function taskHandoff(status:TaskStatus) {
  const goal = status.goal;
  const group = taskGroup(status.status);
  const step = goal?.plan.find(step => step.status === 'running')?.title;
  const summary = group === 'pending' ? goal?.question ?? goal?.reason ?? (status.status === 'awaiting_confirmation' ? '等待确认任务说明和预算' : status.status)
    : goal?.candidate?.summary ?? step ?? (status.interaction === 'chat' ? '普通对话' : '执行目标');
  return {group,summary:summary.slice(0,2000),question:goal?.question ?? null,step:step ?? null,
    budget:{totalTokens:status.budget.totalTokens,estimatedCostUsd:status.budget.priceKnown ? status.budget.estimatedCostUsd : null,costLimit:status.budget.costLimit},
    artifacts:status.status === 'completed' ? goal?.candidate?.artifacts ?? [] : []};
}
