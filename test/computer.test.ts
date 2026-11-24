import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { ComputerBridge } from "../src/computer.js";
import { LocalRuntime } from "../src/runtime.js";
import { demoFixture, until } from "./helpers.js";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { setTimeout } from "node:timers/promises";
import type { Extension, ToolExecutionApi } from "@earendil-works/pi-durable";

const driver = { command: process.execPath, args: ["--import", "tsx", fileURLToPath(new URL("./fixtures/computer-server.ts", import.meta.url))], tools: ["desktop_action", "screen"], observationTools: ["screen"] };
function invoke(extension: Extension, name: string, args = {}) {
  return extension.tools!.find(t => t.name === name)!.execute(args, {} as ToolExecutionApi, context);
}

test("a dependent desktop workflow holds its lease across calls and requires fresh state after reassignment", async () => {
  const bridge = new ComputerBridge();
  try {
    await bridge.connect(driver);
    const a = bridge.forTask("task-a"), b = bridge.forTask("task-b");
    await assert.rejects(() => invoke(a, "computer_0_desktop_action", { text: "missing lease" }), /lease missing/);
    await invoke(a, "computer_begin");
    await assert.rejects(() => invoke(a, "computer_0_desktop_action", { text: "stale state" }), /fresh observation/);
    await invoke(a, "computer_1_screen");
    await invoke(a, "computer_0_desktop_action", { text: "first dependent step" });
    await assert.rejects(() => invoke(b, "computer_begin"), /another task/);
    await invoke(a, "computer_0_desktop_action", { text: "second dependent step" });
    bridge.release("task-b"); // A different task cannot release the owner.
    await assert.rejects(() => invoke(b, "computer_begin"), /another task/);
    await invoke(a, "computer_end");
    await invoke(b, "computer_begin");
    await assert.rejects(() => invoke(b, "computer_0_desktop_action", { text: "reuse A's screenshot" }), /fresh observation/);
    await invoke(b, "computer_1_screen");
    const result = await invoke(b, "computer_0_desktop_action", { text: "own workflow" });
    assert.equal(result.isError, false);
    bridge.release("task-b");
    await assert.rejects(() => invoke(b, "computer_1_screen"), /lease missing/);
  } finally { await bridge.close(); }
});

test("an expired desktop lease cannot reuse a previous capture", async () => {
  const bridge = new ComputerBridge();
  try {
    await bridge.connect({ ...driver, leaseMs: 200 });
    const a = bridge.forTask("task-a");
    await invoke(a, "computer_begin"); await invoke(a, "computer_1_screen");
    await setTimeout(220);
    await assert.rejects(() => invoke(a, "computer_0_desktop_action", { text: "expired" }), /lease missing/);
    await invoke(a, "computer_begin");
    await assert.rejects(() => invoke(a, "computer_0_desktop_action", { text: "old capture" }), /fresh observation/);
    await invoke(a, "computer_1_screen");
    await invoke(a, "computer_0_desktop_action", { text: "fresh capture" });
  } finally { await bridge.close(); }
});

test("MCP desktop actions serialize and screenshot bytes reach the Pi model context", async () => {
  const f = await demoFixture();
  const bridge = new ComputerBridge();
  let runtime: LocalRuntime | undefined;
  try {
    const extension = await bridge.connect({ command: process.execPath, args: ["--import", "tsx", fileURLToPath(new URL("./fixtures/computer-server.ts", import.meta.url))], tools: ["desktop_action", "screen"] });
    const faux = fauxProvider({ provider: "test", models: [{ id: "vision", input: ["text", "image"] }] });
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("computer_0_desktop_action", { text: "first" }),
        fauxToolCall("computer_0_desktop_action", { text: "second" }),
        fauxToolCall("computer_1_screen", {}),
      ], { stopReason: "toolUse" }),
      context => {
        const results = context.messages.filter(m => m.role === "toolResult");
        assert.equal(results.length, 3);
        assert.ok(results.every(r => !r.isError));
        const actions = results.filter(r => r.toolName === "computer_0_desktop_action");
        assert.ok(actions.every(r => r.content.some(b => b.type === "text" && JSON.parse(b.text).atStart === 1)));
        assert.ok(results.some(r => r.content.some(b => b.type === "image" && b.mimeType === "image/png" && b.data.length > 0)));
        return fauxAssistantMessage(fauxToolCall("task_submit", { summary: "Verified simulated desktop actions and screenshot.", artifacts: [] }), { stopReason: "toolUse" });
      },
      fauxAssistantMessage(fauxToolCall("review_result", { verdict: "pass", reason: "Simulated desktop action transcript verified.", evidence: [] }), { stopReason: "toolUse" }),
    ]);
    const models = createModels(); models.setProvider(faux.provider);
    runtime = new LocalRuntime({ ...f.config, model: { provider: "test", modelId: "vision" } }, { models, extensions: [extension] });
    const task = await runtime.create("Verify simulated desktop controls.", f.workspace);
    const status = await until(() => runtime!.status(task.id), s => ["completed", "failed"].includes(s.status));
    assert.equal(status.status, "completed", JSON.stringify(status.submission));
  } finally { await runtime?.close(); await bridge.close(); await f.close(); }
});

test("Pi requests omit superseded browser payloads while keeping the durable results and lease boundaries", async () => {
  const f = await demoFixture();
  const bridge = new ComputerBridge();
  let runtime: LocalRuntime | undefined;
  try {
    await bridge.connect({ ...driver, args: [...driver.args, "--browser"],
      tools: ["agent_browser_snapshot", "agent_browser_screenshot", "agent_browser_click"],
      observationTools: ["agent_browser_snapshot", "agent_browser_screenshot"] });
    const snapshot = "computer_0_agent_browser_snapshot", screenshot = "computer_1_agent_browser_screenshot", click = "computer_2_agent_browser_click";
    const faux = fauxProvider({ provider: "test", models: [{ id: "vision", input: ["text", "image"] }] });
    const call = (name: string, id: string, args = {}) => fauxAssistantMessage(fauxToolCall(name, args, { id }), { stopReason: "toolUse" });
    const requests: Record<string, TranscriptContext["messages"]> = {};
    faux.setResponses([
      call("computer_begin", "begin"), call(snapshot, "old"), call(snapshot, "full", { interactive: false }), call(click, "action"),
      call(snapshot, "error", { fail: true }), call(screenshot, "first-image"), call(screenshot, "last-image"),
      request => { requests.before = request.messages; return call(snapshot, "latest"); },
      async request => {
        requests.after = request.messages;
        await bridge.takeover(); await bridge.returnControl();
        return call("computer_begin", "handoff");
      },
      request => { requests.handoff = request.messages; return call(snapshot, "fresh"); },
      request => { requests.fresh = request.messages; return call("task_submit", "submit", { summary: "Observed the browser after return.", artifacts: [] }); },
    ]);
    const models = createModels(); models.setProvider(faux.provider);
    runtime = new LocalRuntime({ ...f.config, review: false, model: { provider: "test", modelId: "vision" } }, { models, computer: bridge });
    const task = await runtime.create("Verify browser observations before and after handoff.", f.workspace);
    const status = await until(() => runtime!.status(task.id), s => ["completed", "failed"].includes(s.status));
    assert.equal(status.status, "completed");

    const byId = (messages: TranscriptContext["messages"], id: string) => {
      const result = messages.find(m => m.role === "toolResult" && m.toolCallId === id);
      assert(result?.role === "toolResult", `Missing result for ${id}`);
      return result;
    };
    const old = byId(requests.after!, "old"), stored = byId(status.messages, "old");
    assert.match(JSON.stringify(byId(requests.before!, "old").content), /first snapshot/);
    assert.match(JSON.stringify(stored.content), /first snapshot/);
    assert.match(JSON.stringify(old.content), /superseded/i);
    assert.ok(Buffer.byteLength(JSON.stringify(stored.content)) - Buffer.byteLength(JSON.stringify(old.content)) > 1_900);
    assert.equal(old.toolName, stored.toolName);
    assert.equal(old.timestamp, stored.timestamp);
    for (const id of ["full", "action", "error", "latest", "last-image"]) {
      assert.deepEqual(byId(requests.after!, id).content, byId(status.messages, id).content);
    }
    assert.equal(byId(requests.after!, "error").isError, true);
    assert.ok(byId(status.messages, "first-image").content.some(block => block.type === "image"));
    assert.ok(byId(requests.after!, "first-image").content.every(block => block.type !== "image"));
    assert.deepEqual(byId(requests.after!, "first-image").content[0], { type: "text", text: "screenshot receipt 1" });
    assert.deepEqual(byId(requests.handoff!, "latest").content, byId(requests.fresh!, "latest").content);
    assert.deepEqual(byId(requests.fresh!, "fresh").content, byId(status.messages, "fresh").content);
  } finally { await runtime?.close(); await bridge.close(); await f.close(); }
});
