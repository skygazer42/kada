import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
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
