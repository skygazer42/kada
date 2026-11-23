import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { scriptedFixture, until } from "./helpers.js";

const budget = { maxEstimatedCostUsd: 1, maxDurationMs: 10_000, maxTotalTokens: 10_000 };

test("only changed artifacts notify across separate routine workspaces", async () => {
  let content = "same";
  const fixture = await scriptedFixture((context) => {
    if (!context.messages.some((message) => message.role === "toolResult" && message.toolName === "write")) {
      return fauxAssistantMessage(fauxToolCall("write", { path: "summary.txt", content }), { stopReason: "toolUse" });
    }
    return fauxAssistantMessage(fauxToolCall("task_submit", {
      summary: "Project summary",
      artifacts: ["summary.txt"],
    }), { stopReason: "toolUse" });
  });
  const { runtime } = fixture;
  async function run(slot: number) {
    const task = await runtime.create("Write the project summary", undefined, [], {
      routineOccurrenceId: "auto-workspace/1/" + new Date(Date.UTC(2026, 10, 23, slot)).toISOString(),
      notifyOnChange: true,
      budget,
    });
    await until(() => runtime.status(task.id), (status) => status.status === "completed");
    return task;
  }
  const completionCount = async () => (await runtime.notifications()).filter((item) => item.event === "completed").length;
  try {
    const first = await run(1);
    assert.equal(await completionCount(), 1);
    const second = await run(2);
    assert.notEqual(first.workspace, second.workspace);
    assert.equal(await completionCount(), 1);

    content = "changed";
    await run(3);
    assert.equal(await completionCount(), 2);
  } finally {
    await fixture.close();
  }
});

test("cancelling a claimed routine discards its queued task admission", { timeout: 30_000 }, async () => {
  let modelCalls = 0;
  const fixture = await scriptedFixture(() => {
    modelCalls += 1;
    return fauxAssistantMessage("This task should never reach the model.");
  });
  const { runtime } = fixture;
  const create = runtime.create.bind(runtime);
  const queue = (runtime as unknown as { changes: { run<T>(change: () => Promise<T>): Promise<T> } }).changes;
  let unblock!: () => void;
  const blocked = new Promise<void>((resolve) => { unblock = resolve; });
  const ahead = queue.run(() => blocked);
  let admission: ReturnType<typeof runtime.create> | undefined;
  runtime.create = (...args) => {
    admission = create(...args);
    void admission.catch(() => {});
    return admission;
  };

  try {
    const rule = await runtime.routines.create({
      action: "task",
      objective: "An occurrence cancelled while waiting for admission",
      schedule: { kind: "once", at: new Date(Date.now() + 200).toISOString() },
      budget,
    });
    const queued = await until(async () => ({ admission }), (value) => Boolean(value.admission));
    const cancelling = runtime.routines.cancel(rule.id);
    void cancelling.catch(() => {});
    await until(() => runtime.routines.list(), (rules) =>
      rules.some((item) => item.id === rule.id && item.status === "cancelled"));
    unblock();
    await ahead;
    await cancelling;

    await assert.rejects(queued.admission!);
    assert.equal((await runtime.routines.list())[0]?.status, "cancelled");
    assert.deepEqual(await runtime.list(), []);
    assert.equal(modelCalls, 0);
  } finally {
    unblock();
    await ahead;
    runtime.create = create;
    await fixture.close();
  }
});
