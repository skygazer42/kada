import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { Extension, ToolExecutionApi } from "@earendil-works/pi-durable";
import { ComputerBridge } from "../src/computer.js";

const driver = {
  command: process.execPath,
  args: ["--import", "tsx", fileURLToPath(new URL("./fixtures/computer-server.ts", import.meta.url))],
  tools: ["desktop_action", "screen"],
  observationTools: ["screen"],
};

test("U01 desktop takeover fences new calls, drains the active call and requires fresh observation after return", async (t) => {
  const bridge = new ComputerBridge();
  t.after(() => bridge.close());
  await bridge.connect({ ...driver, leaseMs: 500 });
  const task = bridge.forTask("task-a");
  const invoke = (name: string, args = {}, abortSignal?: AbortSignal) => task.tools!.find((tool) => tool.name === name)!.execute(
    args, {} as ToolExecutionApi, { abortSignal } as Parameters<NonNullable<Extension["tools"]>[number]["execute"]>[2],
  );
  const observe = async () => {
    const result = await invoke("computer_1_screen");
    const text = result.output?.find(block => block.type === "text");
    assert(text?.type === "text");
    return JSON.parse(text.text);
  };
  await invoke("computer_begin");
  await invoke("computer_1_screen");
  assert.equal(bridge.status().observed, true);
  const active = assert.rejects(invoke("computer_0_desktop_action", { text: "started" }), /control|cancel|abort/i);
  for (let attempts = 0; !bridge.status().busy && attempts < 20; attempts++) await Promise.resolve();
  assert.equal(bridge.status().busy, true);
  assert.equal(bridge.status().activeTool, "desktop_action");
  const previouslyQueued = assert.rejects(invoke("computer_0_desktop_action", { text: "queued" }), /control|takeover/i);
  const takeover = bridge.takeover();
  assert.equal(bridge.status().mode, "user");
  assert.equal(bridge.status().takingOver, true);
  const queued = assert.rejects(invoke("computer_begin"), /control|takeover/i);
  const [,,, taken] = await Promise.all([active, previouslyQueued, queued, takeover]);
  assert.equal(taken.uncertain, true);
  assert.equal(bridge.status().owner, null);
  assert.equal(bridge.status().busy, false);
  await assert.rejects(invoke("computer_1_screen"), /control|takeover/i);
  await bridge.returnControl();
  assert.equal(bridge.status().mode, "agent");
  assert.equal(bridge.status().uncertain, true);
  await assert.rejects(invoke("computer_0_desktop_action", { text: "old lease" }), /lease/i);
  await invoke("computer_begin");
  await assert.rejects(invoke("computer_0_desktop_action", { text: "old screen" }), /observation/i);
  assert.deepEqual(await observe(), ["started"]);
  assert.equal(bridge.status().uncertain, false);
  await invoke("computer_0_desktop_action", { text: "new screen" });
  const abort = new AbortController();
  const cancelled = assert.rejects(invoke("computer_0_desktop_action", { text: "cancelled reply" }, abort.signal), /abort/i);
  for (let attempts = 0; !bridge.status().busy && attempts < 20; attempts++) await Promise.resolve();
  assert.equal(bridge.status().busy, true);
  abort.abort();
  await cancelled;
  assert.equal(bridge.status().uncertain, true);
  await assert.rejects(invoke("computer_0_desktop_action", { text: "needs observation" }), /observation/i);
  assert.deepEqual(await observe(), ["started", "new screen", "cancelled reply"]);
  assert.equal(bridge.status().uncertain, false);
  assert.equal((await invoke("computer_0_desktop_action", { text: "partial error" })).isError, true);
  assert.equal(bridge.status().uncertain, true);
  assert.deepEqual(await observe(), ["started", "new screen", "cancelled reply", "partial error"]);
  assert.equal(bridge.status().uncertain, false);
  await setTimeout(525);
  assert.equal(bridge.status().owner, null);
  await assert.rejects(invoke("computer_0_desktop_action", { text: "expired" }), /lease/i);
  await bridge.close();
  assert.equal(bridge.status().connected, false);
  await bridge.connect({ ...driver, leaseMs: 500 });
  assert.equal(bridge.status().connected, true);
  await invoke("computer_begin");
  await assert.rejects(invoke("computer_0_desktop_action", { text: "previous connection" }), /observation/i);
  await invoke("computer_1_screen");
  await invoke("computer_0_desktop_action", { text: "current connection" });
});
