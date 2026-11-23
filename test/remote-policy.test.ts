import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTool, Harness } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { localEnvironment } from "../src/execution.js";
import { goalExtension } from "../src/goal.js";
import { preparationExtension } from "../src/preparation.js";
import { remoteFilePolicy, remoteFileTools } from "../src/remote-policy.js";
import { Workspace } from "../src/workspace.js";

test("remote policy guards native aliases, commands and acceptance checks using the child's actual cwd", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "kada-remote-policy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const workspace = await Workspace.open(join(directory, "workspace"));
  const cwd = join(workspace.root, "agents", "child");
  await mkdir(cwd, { recursive: true });
  const outside = join(directory, "owner.txt");
  await writeFile(outside, "OWNER_PRIVATE_SYNTHETIC");
  await symlink(directory, join(cwd, "escape"), process.platform === "win32" ? "junction" : "dir");
  const brief = { outcome: "Make a file.", deliverables: ["report.txt"], inputs: [], scope: ["Workspace"], assumptions: [], questions: [] };
  const denied = [
    { name: "read", args: { path: outside } },
    { name: "read", args: { path: pathToFileURL(outside).href } },
    { name: "read", args: { path: "@" + outside } },
    { name: "read", args: { path: "~/owner.txt" } },
    { name: "read", args: { path: "escape/owner.txt" } },
    { name: "write", args: { path: outside, content: "replaced" } },
    { name: "edit", args: { path: outside, oldText: "OWNER_PRIVATE_SYNTHETIC", newText: "replaced" } },
    { name: "list_files", args: { path: directory } },
    { name: "copy_file", args: { source: outside, destination: "copy.bin" } },
    { name: "copy_file", args: { source: "report.txt", destination: outside } },
    { name: "task_prepare", args: { ...brief, criteria: [{ text: "Run a command", method: "check" }] } },
    { name: "task_prepare", args: { ...brief, criteria: [{ text: "Inspect", method: "inspect", verification: { command: "echo unsafe", inputs: ["source"], outputs: ["report.txt"] } }] } },
    { name: "task_prepare", args: { ...brief, criteria: [{ text: "Inspect", method: "inspect" }], checks: [{ type: "file_exists", path: "report.txt", command: "echo unsafe" }] } },
    { name: "task_plan", args: { steps: [{ id: "one", title: "Make a file" }], checks: [{ type: "file_exists", path: "report.txt", command: "echo unsafe" }] } },
    ...["bash", "task_verify", "run_skill_script", "owner_memory"].map((name) => ({ name, args: {} })),
  ];
  let unsafeCalls = 0;
  const external = defineExtension({ name: "unsafe_fixture_capabilities", tools: ["bash", "task_verify", "run_skill_script", "owner_memory"].map((name) => defineTool({
    name, description: "Unavailable capability fixture.", parameters: Type.Object({}), execute: async () => {
      unsafeCalls++;
      return { output: [{ type: "text", text: "OWNER_PRIVATE_SYNTHETIC" }] };
    },
  })) });
  const faux = fauxProvider({ provider: "remote-policy-test", models: [{ id: "scripted" }] });
  const allowed = [
    { name: "write", args: { path: "report.txt", content: "first" } },
    { name: "edit", args: { path: "report.txt", oldText: "first", newText: "verified" } },
    { name: "read", args: { path: "report.txt" } },
    { name: "list_files", args: { path: "." } },
    { name: "copy_file", args: { source: "report.txt", destination: "copy.bin" } },
  ];
  faux.setResponses([...denied, ...allowed].map(({ name, args }) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" })).concat(fauxAssistantMessage("Done.")));
  const models = createModels(); models.setProvider(faux.provider);
  const extensions = [preparationExtension(workspace, { maxEstimatedCostUsd: 1, maxDurationMs: 30000 }),
    remoteFileTools(workspace), goalExtension(), external, remoteFilePolicy(workspace)];
  const registry = createRegistry();
  for (const extension of extensions) registry.install(extension);
  const harness = await Harness.open(new MemoryStorage(), { models, registry, env: ({ cwd: actual }) => localEnvironment(actual ?? workspace.root) }, ctx);
  t.after(() => harness.close(ctx));
  const root = await harness.root(ctx, { agent: { model: { provider: "remote-policy-test", modelId: "scripted" }, cwd, extensions } });
  assert.equal((await (await root.submit({ type: "input", content: "Exercise the remote tool boundary." }, ctx)).wait(ctx)).status, "done");
  const results = (await root.context(ctx)).entries.flatMap((entry) => entry.model ?? []).filter((message) => message.role === "toolResult");
  assert.equal(results.length, denied.length + allowed.length);
  for (const [index, attempted] of denied.entries()) {
    assert.equal(results[index]?.isError, true, attempted.name + " must be denied");
    assert.match(JSON.stringify(results[index]), /blocked/, attempted.name + " must be refused by the policy before execution");
    assert(!JSON.stringify(results[index]).includes("OWNER_PRIVATE_SYNTHETIC"));
  }
  assert.equal(unsafeCalls, 0);
  assert(results.slice(denied.length).every((message) => !message.isError));
  assert.equal(await readFile(outside, "utf8"), "OWNER_PRIVATE_SYNTHETIC");
  assert.equal(await readFile(join(cwd, "report.txt"), "utf8"), "verified");
  assert.equal(await readFile(join(cwd, "copy.bin"), "utf8"), "verified");
});

test("native path aliases cannot redirect a Unicode workspace root into its neighbor", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "kada-remote-alias-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const workspace = await Workspace.open(join(directory, "work\u00A0space"));
  const neighbor = join(directory, "work space");
  await mkdir(neighbor);
  await writeFile(join(workspace.root, "report.txt"), "conversation report");
  await writeFile(join(neighbor, "report.txt"), "NEIGHBOR_PRIVATE_SYNTHETIC");
  const faux = fauxProvider({ provider: "remote-alias-test", models: [{ id: "scripted" }] });
  faux.setResponses([fauxAssistantMessage(fauxToolCall("read", { path: pathToFileURL(join(workspace.root, "report.txt")).href }), { stopReason: "toolUse" }), fauxAssistantMessage("Done.")]);
  const models = createModels(); models.setProvider(faux.provider);
  const extensions = [remoteFileTools(workspace), remoteFilePolicy(workspace)];
  const registry = createRegistry();
  for (const extension of extensions) registry.install(extension);
  const harness = await Harness.open(new MemoryStorage(), { models, registry, env: ({ cwd }) => localEnvironment(cwd ?? workspace.root) }, ctx);
  t.after(() => harness.close(ctx));
  const root = await harness.root(ctx, { agent: { model: { provider: "remote-alias-test", modelId: "scripted" }, cwd: workspace.root, extensions } });
  await (await root.submit({ type: "input", content: "Read the workspace report." }, ctx)).wait(ctx);
  const result = (await root.context(ctx)).entries.flatMap((entry) => entry.model ?? []).find((message) => message.role === "toolResult");
  assert(!JSON.stringify(result).includes("NEIGHBOR_PRIVATE_SYNTHETIC"));
  assert.equal(result?.role === "toolResult" && result.isError, true);
});
