import assert from "node:assert/strict";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { defineExtension, wrapTool, type JsonObject } from "@earendil-works/pi-durable";
import { createBashTool } from "@earendil-works/pi-durable/tools";
import { LocalRuntime } from "../../src/runtime.js";
import { fakeRoutineClock, until } from "../helpers.js";

const [mode, dataDir, scenario] = process.argv.slice(2) as ["create" | "recover", string, "routine" | "verification"];
const verify = scenario === "verification";
const workspace = join(dataDir, "workspace");
const due = Date.UTC(2026, 10, 23, 12);
const clock = fakeRoutineClock(mode === "create" ? due - 60_000 : due + 60_000);
const model = { provider: "routine-fixture", modelId: "scripted" };
const provider = fauxProvider({ provider: model.provider, models: [{ id: model.modelId }] });
const call = (name: string, args: JsonObject) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const command = "dispatch-fixture-label";
provider.setResponses(Array.from({ length: 12 }, () => context => {
  if (getCurrentTools(context.messages).some(tool => tool.name === "task_prepare")) return call("task_prepare", {
    outcome: "Dispatch one synthetic label.", deliverables: ["labels.txt"], inputs: [], scope: ["Synthetic workspace"],
    assumptions: [], questions: [], criteria: [{ method: "inspect", text: "A single label exists in the dispatch log." }],
  });
  const results = context.messages.filter(message => message.role === "toolResult");
  const toolName = verify ? "task_verify" : "bash";
  const attempt = results.find(message => message.toolName === toolName);
  if (!attempt) return call(toolName, verify ? { command, inputs: [], outputs: ["labels.txt"] } : { command });
  assert.match(getCurrentSystemPrompt(context.messages), /After interruption inspect actual state before retrying side effects/);
  assert(attempt.isError && /interrupt/i.test(JSON.stringify(attempt.content)), "Pi must report the unacknowledged effect as interrupted");
  if (verify) assert.match(JSON.stringify(attempt.content), /Inspect actual state before retrying/);
  const observed = results.find(message => message.toolName === "read" && !message.isError);
  if (!observed) return call("read", { path: "labels.txt" });
  assert.match(JSON.stringify(observed.content), /label-1/);
  return call("task_submit", { summary: "Found the existing label after restart.", artifacts: ["labels.txt"],
    ...(verify ? { criteria: [{ id: 1, status: "passed", evidence: "Read the existing label in the dispatch log." }] } : {}) });
}));
const models = createModels();
models.setProvider(provider.provider);
const effect = defineExtension({ name: "routine_effect_fixture", wraps: [wrapTool(createBashTool(), bash => ({
  ...bash,
  execute: async (args, _api, ctx) => {
    assert.equal(args.command, command);
    await appendFile(join(workspace, "labels.txt"), "label-1\n");
    console.log(JSON.stringify({ type: "ready" }));
    await setTimeout(60_000, undefined, { signal: ctx.abortSignal });
    throw new Error("Fixture did not interrupt the command");
  },
}))] });
const runtime = new LocalRuntime({ dataDir, port: 4317, model, maxSubagents: 1, maxDurationMs: 60_000, web: false, review: false, discovery: false },
  { models, extensions: [effect], routineClock: clock });
const routineId = "dispatch";
try {
  if (mode === "create") {
    await mkdir(workspace);
    if (verify) {
      const task = await runtime.create("Dispatch one label.", workspace, [], { prepare: true });
      const ready = await until(() => runtime.status(task.id), value => value.status === "awaiting_confirmation");
      await runtime.confirm(task.id, ready.goal!.brief!.revision, ready.briefDigest!);
    } else {
      const create = runtime.create.bind(runtime);
      runtime.create = async (...args) => {
        const task = await create(...args);
        // Leave the timer's claim without a receipt even after the task's effect lands.
        await setTimeout(60_000, undefined, { signal: args[3]?.signal });
        return task;
      };
      await runtime.routines.create({ id: routineId, action: "task", workspace, objective: "Dispatch one label.",
        schedule: { kind: "once", at: new Date(due).toISOString() }, budget: { maxEstimatedCostUsd: 1, maxDurationMs: 60_000, maxTotalTokens: 20_000 } });
      await until(async () => clock.waitingAt(due), Boolean);
      clock.advanceTo(due);
    }
    await setTimeout(60_000);
  } else {
    await runtime.recover();
    const history = verify ? [] : await until(() => runtime.routines.history(routineId), rows => rows.some(row => row.status === "started"));
    const [task] = await runtime.list();
    assert(task);
    const taskId = task.id;
    const status = await until(() => runtime.status(taskId), value => ["completed", "failed", "needs_attention"].includes(value.status));
    assert.equal(status.status, "completed", JSON.stringify(status.goal?.proofs));
    const tools = status.messages.flatMap(message => message.role === "toolResult" ? [[message.toolName, message.isError]] : []);
    console.log(JSON.stringify({ type: "completed", history: history.map(row => [row.status, row.taskId]), tasks: (await runtime.list()).map(task => task.id), tools }));
  }
} finally { await runtime.close(); }
