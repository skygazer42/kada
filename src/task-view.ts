import type { TaskStatus } from "./client.js";
import { skillRecords, verificationText } from "./presentation.js";
import { conversationAnswer } from "./conversation.js";

/** A delivery-oriented projection; no transcript, tool output or independent task state. */
export function taskView(status: TaskStatus) {
  const goal = status.goal;
  const message = status.interaction === "chat" ? [...status.messages].reverse().find(m => conversationAnswer(m) !== undefined) : undefined;
  return {
    id: status.id, objective: status.objective, workspace: status.workspace, status: status.status,
    thread: status.thread ?? null,
    interaction: status.interaction,
    reply: message ? { timestamp: message.timestamp, text: conversationAnswer(message)! } : null,
    brief: goal?.brief ?? null, briefDigest: status.briefDigest,
    confirmed: Boolean(goal?.confirmation), question: goal?.question ?? status.userQuestion?.text ?? null, userQuestion: status.userQuestion,
    reason: goal?.reason ?? status.initializationError ?? null,
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
    assistantWork: status.assistantWork,
    stoppableChildren: status.status === "running" ? status.delegations.flatMap(child => child.mode === "background" &&
      ["queued", "running", "waiting_input"].includes(child.status) ? [{ childId: child.conversationId, name: child.name }] : []) : [],
    interruptibleChildTools: status.interruptibleChildTools,
    approvals: status.approvals.map(({ arguments: args, ...approval }) => ({
      ...approval, argumentsPreview: JSON.stringify(args, null, 2),
    })),
    delivery: status.status === "completed" && goal?.candidate ? {
      summary: goal.candidate.summary, artifacts: goal.candidate.artifacts,
      verification: verificationText(status), assumptions: goal.brief?.assumptions ?? [],
    } : null,
  };
}

export type TaskView = ReturnType<typeof taskView>;

export function taskGroup(status: TaskStatus['status']) {
  return ['waiting_user','waiting_assistant','blocked','needs_attention','clarifying','awaiting_confirmation','failed','paused','budget_limited'].includes(status) ? 'pending'
    : ['completed','answered'].includes(status) ? 'delivered' : status === 'cancelled' ? 'closed' : 'running';
}

export function taskHandoff(status:TaskStatus) {
  const goal = status.goal;
  const child = status.status === "running" ? status.delegations.find(item => item.status === "waiting_input") : undefined;
  const group = status.thread?.archivedAt ? 'archived' : child ? "pending" : taskGroup(status.status);
  const step = goal?.plan.find(step => step.status === 'running')?.title;
  const peerQuestion = status.status === 'waiting_assistant' ? status.assistantWork
    .find(work => !work.stop && !work.result && work.origin.revision === goal?.revision && work.origin.epoch === goal?.epoch &&
      work.questions.some(question => !question.answer))?.questions.find(question => !question.answer) : undefined;
  const question = goal?.question ?? status.userQuestion?.text ?? child?.question?.text ?? peerQuestion?.text ?? null;
  const summary = group === 'pending' ? question ?? goal?.reason ?? (status.status === 'awaiting_confirmation' ? '等待确认任务说明和预算' : status.status)
    : goal?.candidate?.summary ?? step ?? (status.interaction === 'chat' ? '普通对话' : '执行目标');
  return {group,summary:summary.slice(0,2000),question,step:step ?? null,
    budget:{totalTokens:status.budget.totalTokens,estimatedCostUsd:status.budget.priceKnown ? status.budget.estimatedCostUsd : null,costLimit:status.budget.costLimit},
    artifacts:status.status === 'completed' ? goal?.candidate?.artifacts ?? [] : []};
}
