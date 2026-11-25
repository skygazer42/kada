import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:net";
import { setTimeout } from "node:timers/promises";
import test from "node:test";
import { awaitWithContext, BACKGROUND_CONTEXT as ctx, withAbortSignal } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createRegistry, Harness, UserEntry, type JsonObject } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { delegationExtension } from "../src/delegation.js";
import { localEnvironment, localExecution } from "../src/execution.js";
import { goalExtension } from "../src/goal.js";
import { LocalRuntime } from "../src/runtime.js";
import { ChatSession } from "../src/chat.js";
import { createClient } from "../src/client.js";
import { serve } from "../src/server.js";
import { hasTool, scriptedFixture, until } from "./helpers.js";

test("background delegation lets the parent work, waits for the report and resumes once after reopening", async () => {
  const release = Promise.withResolvers<void>();
  let reports = 0;
  const call = (name: string, args: JsonObject) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
  const fixture = await scriptedFixture(async (conversation, signal) => {
    const results = conversation.messages.filter(message => message.role === "toolResult");
    if (!hasTool(conversation, "delegate")) {
      assert.equal(hasTool(conversation, "delegate_background"), false);
      if (!results.some(result => result.toolName === "write")) return call("write", { path: "child.txt", content: "Child work" });
      await awaitWithContext(release.promise, signal ? withAbortSignal(signal, ctx) : ctx);
      return fauxAssistantMessage("Reviewed the child evidence.");
    }
    const handedBack = conversation.messages.some(message => message.role === "user" && String(message.content).startsWith("Background delegation finished."));
    if (handedBack) {
      if (!results.some(result => result.toolName === "task_status")) {
        reports++;
        return call("task_status", { delegation: "list" });
      }
      return call("task_submit", { summary: "Used both pieces of evidence", artifacts: [] });
    }
    if (!results.some(result => result.toolName === "delegate_background")) return call("delegate_background", {
      tasks: [{ name: "worker", instructions: "Write child.txt and inspect it." }],
    });
    if (!results.some(result => result.toolName === "write")) return call("write", { path: "parent.txt", content: "Independent parent work" });
    if (!results.some(result => result.toolName === "task_submit")) return call("task_submit", { summary: "Too early", artifacts: [] });
    return fauxAssistantMessage("Waiting briefly for the worker.");
  });
  let reopened: LocalRuntime | undefined;
  try {
    const task = await fixture.runtime.create("Combine independent parent and child evidence", fixture.workspace);
    const before = await until(() => fixture.runtime.status(task.id), status =>
      status.submission?.status === "done" && status.delegations.some(child => child.status === "running"));
    assert.equal(await readFile(join(fixture.workspace, "parent.txt"), "utf8"), "Independent parent work");
    assert.equal(before.goal?.candidate, null);
    assert.equal(before.goal?.reworks, 0);
    assert.equal(before.delegations[0]?.status, "running");
    const child = before.delegations[0]!;
    await until(() => readFile(join(child.directory, "child.txt"), "utf8").catch(() => ""), value => value === "Child work");
    await fixture.runtime.close();
    release.resolve();

    reopened = new LocalRuntime(fixture.settings, { models: fixture.models });
    await reopened.recover();
    const after = await until(() => reopened!.status(task.id), status => status.status === "completed");
    assert.equal(after.goal?.candidate?.summary, "Used both pieces of evidence");
    assert.equal(after.goal?.reworks, 0);
    assert.equal(after.goal?.events.filter(event => event.type === "completed").length, 1);
    assert.deepEqual(after.delegations.map(item => [item.conversationId, item.status, item.answer]), [[child.conversationId, "completed", "Reviewed the child evidence."]]);
    assert.equal(reports, 1);
    assert.equal(after.messages.filter(message => message.role === "user" && String(message.content).startsWith("Background delegation finished.")).length, 1);
  } finally {
    release.resolve();
    await reopened?.close();
    await fixture.close();
  }
});

test("stopping one background child preserves its sibling and reports the batch once", async () => {
  const workerStarted = Promise.withResolvers<void>();
  const workerStopped = Promise.withResolvers<void>();
  const finishSibling = Promise.withResolvers<void>();
  let reports = 0;
  const call = (name: string, args: JsonObject) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
  const fixture = await scriptedFixture(async (conversation, signal) => {
    const users = conversation.messages.filter(message => message.role === "user");
    if (!hasTool(conversation, "delegate_background")) {
      if (users.some(message => message.content === "Keep this sibling working.")) {
        await awaitWithContext(finishSibling.promise, signal ? withAbortSignal(signal, ctx) : ctx);
        return fauxAssistantMessage("Sibling evidence ready.");
      }
      workerStarted.resolve();
      try { await setTimeout(60_000, undefined, { signal }); }
      finally { if (signal?.aborted) workerStopped.resolve(); }
      return fauxAssistantMessage("Stopped worker should not deliver.");
    }
    if (users.some(message => String(message.content).startsWith("Background delegation finished."))) {
      reports++;
      return call("task_submit", { summary: "Delivered available evidence.", artifacts: [] });
    }
    if (conversation.messages.some(message => message.role === "toolResult" && message.toolName === "delegate_background")) {
      return fauxAssistantMessage("Working with the available evidence.");
    }
    return call("delegate_background", { tasks: [
      { name: "stop-me", instructions: "Run the first investigation." },
      { name: "sibling", instructions: "Keep this sibling working." },
    ] });
  });
  const socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const settings = { ...fixture.settings, port };
  const daemon = await serve(settings, { models: fixture.models });
  const runtime = daemon.runtime;
  const client = createClient(settings);
  let reopened: LocalRuntime | undefined;
  try {
    const task = await runtime.create("Gather available evidence", fixture.workspace);
    const before = await until(() => runtime.status(task.id), status =>
      status.delegations.length === 2 && status.delegations.every(child => child.status === "running"));
    await workerStarted.promise;
    const [child, sibling] = before.delegations;
    const stopPath = `/v1/tasks/${task.id}/delegations/${child!.conversationId}/stop`;
    const unauthenticated = await fetch(`http://127.0.0.1:${port}${stopPath}`, { method: "POST" });
    assert.equal(unauthenticated.status, 401);
    await assert.rejects(client.request(`/v1/tasks/${task.id}/delegations/9999/stop`, "POST", {}), /Background child not found/);
    const events: string[] = [];
    const chat = new ChatSession(client, event => events.push(event.text));
    await chat.attach(task.id);
    await chat.handle("/children");
    assert(events.some(event => event.includes(`${child!.conversationId} [running] stop-me`)));
    await chat.handle(`/stop-child ${child!.conversationId}`);
    await workerStopped.promise;
    assert.deepEqual(await client.request(stopPath, "POST", {}), { childId: child!.conversationId, stopped: true });
    assert.deepEqual((await runtime.status(task.id)).delegations.map(item => item.status), ["cancelled", "running"]);
    assert.equal(reports, 0);
    await daemon.close();
    finishSibling.resolve();
    reopened = new LocalRuntime(fixture.settings, { models: fixture.models });
    await reopened.recover();
    const after = await until(() => reopened!.status(task.id), status => status.status === "completed");
    assert.deepEqual(after.delegations.map(item => [item.conversationId, item.status, item.answer]), [
      [child!.conversationId, "cancelled", undefined],
      [sibling!.conversationId, "completed", "Sibling evidence ready."],
    ]);
    assert.equal(reports, 1);
  } finally {
    finishSibling.resolve();
    await daemon.close();
    await reopened?.close();
    await fixture.close();
  }
});

test("cancelling a goal stops a background child and keeps its receipt without waking the parent", async () => {
  const childStarted = Promise.withResolvers<void>();
  const childStopped = Promise.withResolvers<void>();
  const fixture = await scriptedFixture(async (conversation, signal) => {
    if (hasTool(conversation, "delegate")) {
      const receipt = conversation.messages.some(message => message.role === "toolResult" && message.toolName === "delegate_background");
      if (receipt) return fauxAssistantMessage("Waiting for the child.");
      return fauxAssistantMessage(fauxToolCall("delegate_background", {
        tasks: [{ name: "worker", instructions: "Inspect local evidence." }],
      }), { stopReason: "toolUse" });
    }
    childStarted.resolve();
    try {
      await setTimeout(60_000, undefined, { signal });
    } finally {
      childStopped.resolve();
    }
    return fauxAssistantMessage("Child result.");
  });
  let reopened: LocalRuntime | undefined;
  try {
    const task = await fixture.runtime.create("Run a cancellable background investigation", fixture.workspace);
    const before = await until(() => fixture.runtime.status(task.id), status => status.delegations.some(child => child.status === "running"));
    await childStarted.promise;
    await fixture.runtime.cancel(task.id);
    await childStopped.promise;
    await fixture.runtime.close();
    reopened = new LocalRuntime(fixture.settings, { models: fixture.models });
    await reopened.recover();
    const after = await reopened.status(task.id);
    assert.equal(after.status, "cancelled");
    assert.equal(after.activeWorkerCount, 0);
    assert.deepEqual(after.delegations.map(({ conversationId, status, mode }) => [conversationId, status, mode]),
      [[before.delegations[0]!.conversationId, "cancelled", "background"]]);
    assert.ok(!after.messages.some(message => message.role === "user" && String(message.content).startsWith("Background delegation finished.")));
  } finally {
    await reopened?.close();
    await fixture.close();
  }
});

test("a user follow-up supersedes an outstanding batch before the new revision delivers", async () => {
  const stopped = Promise.withResolvers<void>();
  const fixture = await scriptedFixture(async (conversation, signal) => {
    if (!hasTool(conversation, "delegate")) {
      try {
        await setTimeout(60_000, undefined, { signal });
      } finally {
        stopped.resolve();
      }
      return fauxAssistantMessage("Old evidence.");
    }
    if (conversation.messages.some(message => message.role === "user" && message.content === "Use the local evidence only.")) {
      return fauxAssistantMessage(fauxToolCall("task_submit", { summary: "Used the local evidence", artifacts: [] }), { stopReason: "toolUse" });
    }
    if (conversation.messages.some(message => message.role === "toolResult" && message.toolName === "delegate_background")) {
      return fauxAssistantMessage("Waiting on the old requirements.");
    }
    return fauxAssistantMessage(fauxToolCall("delegate_background", {
      tasks: [{ name: "worker", instructions: "Read the old local material." }],
    }), { stopReason: "toolUse" });
  });
  try {
    const task = await fixture.runtime.create("Review old material and local evidence", fixture.workspace);
    await until(() => fixture.runtime.status(task.id), status =>
      status.submission?.status === "done" && status.delegations[0]?.status === "running");
    await fixture.runtime.followUp(task.id, "Use the local evidence only.");
    const result = await until(() => fixture.runtime.status(task.id), status => status.status === "completed");
    await stopped.promise;
    assert.equal(result.goal?.revision, 2);
    assert.equal(result.goal?.candidate?.summary, "Used the local evidence");
    assert.equal(result.delegations[0]?.status, "cancelled");
    assert.ok(!result.messages.some(message => message.role === "user" && String(message.content).startsWith("Background delegation finished.")));
  } finally {
    await fixture.close();
  }
});

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
