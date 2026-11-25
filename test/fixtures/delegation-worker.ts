import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { JsonObject } from "@earendil-works/pi-durable";
import { GoalDoc } from "../../src/goal.js";
import { markChildStopped } from "../../src/delegation.js";
import { LocalRuntime } from "../../src/runtime.js";
import { hasTool, until } from "../helpers.js";

const [phase, directory, stage] = process.argv.slice(2) as [string, string, string?];
const workspace = join(directory, "workspace");
const reportPrefix = "Background delegation finished.";
const revisedInput = "Use the current evidence only.";
const call = (name: string, args: JsonObject) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const faux = fauxProvider({ provider: "delegation-recovery", models: [{ id: "scripted" }] });
let childWaiting = false;
let workerWrites = 0;
let workerRequests = 0;
faux.setResponses(Array.from({ length: 30 }, () => async (conversation, options) => {
  const results = conversation.messages.filter(message => message.role === "toolResult");
  if (!hasTool(conversation, "delegate_background")) {
    workerRequests++;
    if (!results.some(result => result.toolName === "write" && !result.isError)) {
      workerWrites++;
      return call("write", { path: "evidence.txt", content: "Durable child evidence." });
    }
    if (phase === "create") {
      childWaiting = true;
      await setTimeout(60_000, undefined, { signal: options?.signal });
    }
    return fauxAssistantMessage("Child verified evidence.txt.");
  }
  const hasReport = conversation.messages.some(message =>
    message.role === "user" && typeof message.content === "string" && message.content.startsWith(reportPrefix));
  if (conversation.messages.some(message => message.role === "user" && message.content === revisedInput)) {
    return call("task_submit", { summary: "Delivered the revised goal.", artifacts: [] });
  }
  if (hasReport) {
    if (!results.some(result => result.toolName === "task_status")) return call("task_status", { delegation: "list" });
    return call("task_submit", { summary: "Combined the recovered evidence.", artifacts: [] });
  }
  if (!results.some(result => result.toolName === "delegate_background")) {
    return call("delegate_background", { tasks: [{ name: "evidence", instructions: "Write and verify evidence.txt." }] });
  }
  if (stage === "waiting") return call("task_blocked", { reason: "Need to confirm the detail.", question: "Which detail should I check?" });
  return fauxAssistantMessage("Waiting for the child evidence.");
}));

const models = createModels();
models.setProvider(faux.provider);
const runtime = new LocalRuntime({
  dataDir: directory, port: 4317, model: { provider: "delegation-recovery", modelId: "scripted" },
  maxSubagents: 1, maxDurationMs: 120_000, review: false, web: false, discovery: false,
}, { models });

try {
  if (phase === "create") {
    if (stage === "waiting") clearInterval(runtime["timer"]);
    await runtime.create("Verify the recovered child evidence.", workspace);
  }
  else await runtime.recover();
  const [task] = await runtime.list();
  if (!task) throw new Error("Missing task metadata");
  const status = await until(() => runtime.status(task.id), current => phase === "create"
    ? childWaiting && current.submission?.status === "done" && current.delegations[0]?.status === "running" &&
      (stage !== "waiting" || current.status === "waiting_user")
    : stage === "waiting" ? current.status === "waiting_user"
    : current.status === "completed");
  const [child] = status.delegations;
  if (!child) throw new Error("Missing delegation");
  if (phase === "create" && stage === "revision") {
    const active = runtime["active"].get(task.id);
    if (!active) throw new Error("Missing active task");
    // Persist the same goal transition as followUp, then hold its cancellation and submission for the crash.
    await active.harness.commit(async tx => {
      const goal = await tx.doc(GoalDoc);
      goal.revision++;
      goal.userMessages.push(revisedInput);
      goal.outbox = { requestId: "user:revised-crash-fixture", content: revisedInput };
    }, ctx);
  }
  if (phase === "create" && stage === "child-stop") {
    const active = runtime["active"].get(task.id);
    if (!active || !status.goal) throw new Error("Missing active goal");
    // Stop at the boundary between persisting the decision and aborting the Pi conversation.
    await markChildStopped(active.harness, child.conversationId, status.goal, ctx);
  }
  console.log(JSON.stringify({
    type: phase === "create" ? "ready" : "completed",
    taskId: task.id, childId: child.conversationId, batchId: child.delegationTaskId,
    parentId: child.parentConversationId, childDirectory: child.directory, childStatus: child.status,
    workerWrites, workerRequests, goalStatus: status.status, revision: status.goal?.revision, summary: status.goal?.candidate?.summary ?? null,
    reports: status.messages.filter(message =>
      message.role === "user" && typeof message.content === "string" && message.content.startsWith(reportPrefix)).length,
    deliveries: status.goal?.events.filter(event => event.type === "completed").length ?? 0,
  }));
  if (phase === "create") await setTimeout(60_000);
} finally {
  await runtime.close();
}
