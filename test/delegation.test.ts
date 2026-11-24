import assert from "node:assert/strict";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import test from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createRegistry, Harness, UserEntry, type JsonObject } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { delegationExtension } from "../src/delegation.js";
import { localEnvironment, localExecution } from "../src/execution.js";
import { goalExtension } from "../src/goal.js";
import { LocalRuntime } from "../src/runtime.js";
import { hasTool, scriptedFixture, until } from "./helpers.js";

test("A01 cancelling a parent task stops both owned Pi child conversations", async () => {
  const running = new Set<string>();
  const stopped = new Set<string>();
  const offeredParentTools: string[] = [];
  const fixture = await scriptedFixture(async (conversation, signal) => {
    if (hasTool(conversation, "delegate")) {
      return fauxAssistantMessage(fauxToolCall("delegate", {
        tasks: [
          { name: "alpha", instructions: "Collect alpha evidence" },
          { name: "beta", instructions: "Collect beta evidence" },
        ],
      }), { stopReason: "toolUse" });
    }
    const worker = [...running].includes("alpha") ? "beta" : "alpha";
    running.add(worker);
    for (const tool of ["task_submit", "task_plan", "task_blocked", "task_verify"]) {
      if (hasTool(conversation, tool)) offeredParentTools.push(tool);
    }
    try {
      await setTimeout(60_000, undefined, { signal });
    } finally {
      stopped.add(worker);
    }
    return fauxAssistantMessage("This worker should stop before returning a result.");
  });
  try {
    const task = await fixture.runtime.create("Delegate independently to alpha and beta", fixture.workspace);
    const before = await until(() => fixture.runtime.status(task.id), (status) =>
      running.size === 2 && status.activeWorkerCount === 2);
    assert.deepEqual(offeredParentTools, []);
    assert.deepEqual(before.delegations.map(({ name, status }) => [name, status]), [
      ["alpha", "running"], ["beta", "running"],
    ]);
    assert.equal(new Set(before.delegations.map(({ conversationId }) => conversationId)).size, 2);

    await fixture.runtime.cancel(task.id);
    const after = await until(() => fixture.runtime.status(task.id), (status) =>
      stopped.size === 2 && status.activeWorkerCount === 0);
    assert.deepEqual(after.delegations.map(({ name, status }) => [name, status]), [
      ["alpha", "cancelled"], ["beta", "cancelled"],
    ]);
    assert.deepEqual(
      after.delegations.map(({ conversationId }) => conversationId),
      before.delegations.map(({ conversationId }) => conversationId),
    );
  } finally {
    await fixture.close();
  }
});

test("A02 an owned child cannot submit its parent's objective", async () => {
  let childTurns = 0;
  const fixture = await scriptedFixture((conversation) => {
    if (hasTool(conversation, "delegate")) {
      return fauxAssistantMessage(fauxToolCall("delegate", {
        tasks: [{ name: "worker", instructions: "Provide supporting evidence." }],
      }), { stopReason: "toolUse" });
    }
    assert.equal(hasTool(conversation, "task_submit"), false);
    childTurns += 1;
    if (childTurns === 1) {
      return fauxAssistantMessage(fauxToolCall("task_submit", {
        answer: "ATTEMPTED_PARENT_SUBMISSION", summary: "ATTEMPTED_PARENT_SUBMISSION",
      }), { stopReason: "toolUse" });
    }
    return fauxAssistantMessage("Worker result following the unavailable tool call.");
  });
  try {
    const task = await fixture.runtime.create("Collect supporting evidence without delegating objective completion", fixture.workspace);
    const status = await until(() => fixture.runtime.status(task.id), (current) =>
      current.delegations.some((child) => child.status === "completed"));
    const child = status.delegations.find((item) => item.name === "worker");
    assert.ok(child);
    assert.equal(child.status, "completed");
    assert.equal(child.answer, "Worker result following the unavailable tool call.");
    assert.ok(childTurns >= 2);
    assert.doesNotMatch(JSON.stringify(status.goal), /ATTEMPTED_PARENT_SUBMISSION/);
  } finally {
    await fixture.close();
  }
});

test("a resumed coordinator can read its original delegation results after Pi compaction", async () => {
  const call = (name: string, args: JsonObject) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
  let rootId: number;
  let workerTurns = 0;
  const fixture = await scriptedFixture(conversation => {
    const messages = conversation.messages;
    const system = JSON.stringify(messages.filter(m => m.role === "system"));
    if (system.includes("context summarization assistant")) return fauxAssistantMessage("The coordinator needs to resume its task.");
    const results = messages.filter(m => m.role === "toolResult");
    if (!hasTool(conversation, "delegate")) {
      workerTurns++;
      if (system.includes("FAIL_WORKER")) return fauxAssistantMessage("", { stopReason: "error", errorMessage: "400 invalid_request_error" });
      if (!results.some(m => m.toolName === "write")) return call("write", { path: "result.txt", content: "Durable delegation evidence" });
      return fauxAssistantMessage("The worker wrote result.txt. " + "a".repeat(7_000));
    }
    if (!messages.some(m => m.role === "user" && String(m.content).startsWith("Resume the original objective"))) {
      if (!results.some(m => m.toolName === "delegate")) return call("delegate", { tasks: [
        { name: "original result", instructions: "Save result.txt and report its contents." },
        { name: "failed result", instructions: "FAIL_WORKER" },
      ] });
      return call("task_blocked", { reason: "Pause before checking the delegation results." });
    }
    assert.ok(!results.some(m => m.toolName === "delegate"));
    const statusResults = results.filter(m => m.toolName === "task_status");
    if (!statusResults.length) return call("task_status", { delegation: "list" });
    const children = JSON.parse(statusResults[0]!.content.find(b => b.type === "text")!.text).delegations;
    if (!children) return call("task_blocked", { reason: "Saved delegation list is missing." });
    assert.deepEqual(children.map(({ name, status }: { name: string; status: string }) => [name, status]), [
      ["original result", "completed"], ["failed result", "failed"],
    ]);
    if (statusResults.length === 1) return call("task_status", { delegation: children[0].conversationId });
    if (statusResults.length === 2) return call("task_status", { delegation: children[1].conversationId });
    if (statusResults.length === 3) return call("task_status", { delegation: rootId });
    const result = JSON.parse(statusResults[1]!.content.find(b => b.type === "text")!.text).delegation;
    if (!results.some(m => m.toolName === "read")) return call("read", { path: join(result.directory, "result.txt") });
    return call("task_submit", { summary: "Recovered and checked the original delegation evidence.", artifacts: [] });
  });
  let reopened: LocalRuntime | undefined;
  try {
    const task = await fixture.runtime.create("Preserve delegated work across compaction and restart.", fixture.workspace);
    const before = await until(() => fixture.runtime.status(task.id), status => status.status === "blocked");
    assert.equal(before.delegations.length, 2);
    const turnsBefore = workerTurns;
    await fixture.runtime.close();
    const registry = createRegistry(), goal = goalExtension(), extensions = [
      localExecution(), goal, delegationExtension(fixture.workspace, 2, undefined, [goal]),
    ];
    for (const extension of extensions) registry.install(extension);
    const storage = await openNodeSqliteStorage(join(fixture.directory, "tasks", task.id, "session.sqlite"));
    const harness = await Harness.open(storage, { models: fixture.models, registry, env: () => localEnvironment(fixture.workspace),
      settings: { compaction: { enabled: true, keepRecentTokens: 256, backgroundTokens: 0 } } }, ctx);
    try {
      const root = await harness.root(ctx);
      rootId = root.id;
      for (let chunk = 0; chunk < 2; chunk++) {
        const written = await root.submit({ type: "write", entry: { kind: UserEntry.kind,
          model: [{ role: "user", content: "Archived reference material. ".repeat(3_000), timestamp: Date.now() }] } }, ctx);
        assert.equal((await written.wait(ctx)).status, "done");
      }
      const compact = await root.compact("Keep the objective and progress.", ctx);
      const outcome = (await harness.waitForTask(compact, ctx)).state.outcome;
      assert.ok(outcome.status === "completed" && outcome.result.submissionId !== undefined);
      assert.equal((await (await harness.submission(outcome.result.submissionId, ctx))!.wait(ctx)).status, "done");
      assert.ok(!(await root.context(ctx)).messages.some(m => m.role === "toolResult" && m.toolName === "delegate"));
    } finally { await harness.close(ctx); }
    reopened = new LocalRuntime(fixture.settings, { models: fixture.models });
    await reopened.resume(task.id);
    const after = await until(() => reopened!.status(task.id), status => ["completed", "blocked", "failed"].includes(status.status));
    assert.equal(after.status, "completed", JSON.stringify(after.submission?.detail ?? after.goal?.reason ?? ""));
    assert.equal(after.rootCompactions, 1);
    assert.equal(workerTurns, turnsBefore);
    assert.deepEqual(after.delegations.map(child => child.conversationId), before.delegations.map(child => child.conversationId));
    const statuses = after.messages.filter(m => m.role === "toolResult" && m.toolName === "task_status").map(m =>
      JSON.parse(m.content.find(b => b.type === "text")!.text));
    assert.deepEqual(statuses[0].delegations.map((child: { conversationId: number }) => child.conversationId), before.delegations.map(child => child.conversationId));
    assert.ok(statuses[0].delegations.every((child: object) => !("answer" in child) && !("instructions" in child)));
    assert.equal(statuses[1].delegation.answer, before.delegations[0]!.answer);
    assert.equal(statuses[1].delegation.answer.length, 6_000);
    assert.equal(statuses[1].delegation.truncated, true);
    assert.equal(statuses[2].delegation.reason, "model_error");
    assert.equal(statuses[3].delegation, null);
    const read = after.messages.find(m => m.role === "toolResult" && m.toolName === "read");
    assert.match(JSON.stringify(read), /Durable delegation evidence/);
  } finally { await reopened?.close(); await fixture.close(); }
});
