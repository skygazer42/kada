import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createModels, createProvider, Type, type Context, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { LocalRuntime } from "../src/runtime.js";
import { conversationAnswer } from "../src/conversation.js";
import { until } from "../test/helpers.js";

let apiKey = process.env.SILICONFLOW_API_KEY ?? "";
if (!apiKey) {
  assert(process.stdin.isTTY, "Set SILICONFLOW_API_KEY or run in a terminal.");
  process.stdin.setRawMode(true);
  const input = createInterface({ input: process.stdin, terminal: false });
  console.log("READY_FOR_CREDENTIAL");
  apiKey = await new Promise<string>(done => input.once("line", done));
  input.close();
  process.stdin.setRawMode(false);
  process.stdin.pause();
}
assert(apiKey.trim(), "SiliconFlow credential is required.");
const endpoint = "https://api.siliconflow.cn/v1";
const modelId = process.env.SILICONFLOW_MODEL ?? "Qwen/Qwen2.5-7B-Instruct";
const directory = resolve(".harness/live-siliconflow", randomUUID());
const deadline = AbortSignal.timeout(90_000);
const native = openAICompletionsApi();
let requests = 0;
const guard = () => { assert(requests < 4, "Online smoke request limit reached."); requests++; };
const model: Model<"openai-completions"> = {
  id: modelId, name: modelId, provider: "siliconflow-smoke", api: "openai-completions", baseUrl: endpoint,
  reasoning: false, input: ["text"], contextWindow: 8192, maxTokens: 256,
  // Pricing is unknown to this custom catalog; the report records tokens and leaves monetary cost unset.
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  compat: { maxTokensField: "max_tokens", supportsStore: false, supportsDeveloperRole: false },
};
const models = createModels();
models.setProvider(createProvider({
  id: model.provider, baseUrl: endpoint, models: [model],
  auth: { apiKey: { name: "SiliconFlow smoke", resolve: async () => ({ auth: { apiKey } }) } },
  api: {
    stream: (selected, context, options) => {
      guard();
      const signal = AbortSignal.any([deadline, ...(options?.signal ? [options.signal] : [])]);
      return native.stream(selected, context, { ...options, maxTokens: 256, signal });
    },
    streamSimple: (selected, context, options) => {
      guard();
      const signal = AbortSignal.any([deadline, ...(options?.signal ? [options.signal] : [])]);
      return native.streamSimple(selected, context, { ...options, maxTokens: 256, signal });
    },
  },
}));
const config = {
  dataDir: join(directory, "state"), port: 4317, model: { provider: model.provider, modelId },
  maxSubagents: 1, maxDurationMs: 90_000, maxTotalTokens: 16_000,
  review: false, web: false, discovery: false,
};
let runtime: LocalRuntime | undefined;
try {
  const catalogResponse = await fetch(endpoint + "/models", { headers: { Authorization: "Bearer " + apiKey }, signal: deadline });
  assert.equal(catalogResponse.status, 200, "SiliconFlow model catalog authentication failed.");
  const catalog = await catalogResponse.json() as { data: { id: string }[] };
  assert(catalog.data.some(item => item.id === modelId), "Selected smoke model is absent from the account catalog.");
  console.log(JSON.stringify({ stage: "catalog", passed: true, model: modelId }));
  const context: Context = {
    systemPrompt: "Use the add_numbers tool for arithmetic. After receiving its result, answer with the number only.",
    messages: [{ role: "user", content: "Use add_numbers to add 19 and 23.", timestamp: Date.now() }],
    tools: [{ name: "add_numbers", description: "Add two numbers.", parameters: Type.Object({ a: Type.Number(), b: Type.Number() }) }],
  };
  const first = await models.complete(model, context, { toolChoice: { type: "function", function: { name: "add_numbers" } } });
  const call = first.content.find(part => part.type === "toolCall");
  assert(call && call.name === "add_numbers", "The live model did not return the required tool call.");
  assert.deepEqual(call.arguments, { a: 19, b: 23 });
  context.messages.push(first, {
    role: "toolResult", toolCallId: call.id, toolName: call.name,
    content: [{ type: "text", text: String(Number(call.arguments.a) + Number(call.arguments.b)) }],
    isError: false, timestamp: Date.now(),
  });
  const second = await models.complete(model, context, { toolChoice: "none" });
  assert.match(second.content.filter(part => part.type === "text").map(part => part.text).join(""), /42/);
  console.log(JSON.stringify({ stage: "pi-tool-roundtrip", passed: true }));
  await mkdir(join(directory, "workspace"), { recursive: true });
  runtime = new LocalRuntime(config, { models });
  const task = await runtime.create("本次普通对话的代号为 MARKER_531。只回复 MARKER_531。", join(directory, "workspace"), [], { chat: true });
  const firstChat = await until(() => runtime!.status(task.id), status => status.status === "answered", 90_000);
  assert.equal(firstChat.goal, undefined);
  assert(firstChat.messages.some(message => conversationAnswer(message)?.includes("MARKER_531")));
  await runtime.close();
  runtime = new LocalRuntime(config, { models });
  await runtime.recover();
  const beforeFollowUp = requests;
  assert.equal(beforeFollowUp, 3, "Reopening an answered conversation should use the saved Pi session.");
  const followUp = "刚才的代号是什么？只回复代号。";
  await runtime.followUp(task.id, followUp, "sf-recall");
  const recalled = await until(() => runtime!.status(task.id), status => status.status === "answered" && status.submission?.requestId === "user:sf-recall", 90_000);
  assert.equal(recalled.goal, undefined);
  const answer = recalled.messages.map(conversationAnswer).filter(text => text !== undefined).at(-1);
  assert.match(answer ?? "", /MARKER_531/);
  const callsBeforeDuplicate = requests;
  await runtime.followUp(task.id, followUp, "sf-recall");
  await runtime.status(task.id);
  assert.equal(requests, callsBeforeDuplicate);
  assert.equal(requests, 4);
  const report = {
    passed: true, endpoint, model: modelId, modelRequests: requests, maxOutputTokensPerRequest: 256,
    tests: { catalog: true, piToolRoundTrip: true, kadaConversationAfterRestart: true, duplicateFollowUp: true },
    tokens: {
      toolInput: first.usage.input + second.usage.input,
      toolOutput: first.usage.output + second.usage.output,
      chatTotal: recalled.budget.totalTokens,
    },
    estimatedCostUsd: null, pricingKnown: false, realModel: true, os: process.platform,
  };
  await writeFile(join(directory, "result.json"), JSON.stringify(report, null, 2) + "\n");
  const persisted = await readFile(join(directory, "result.json"), "utf8");
  assert(!persisted.includes(apiKey));
  console.log(JSON.stringify({ ...report, record: join(directory, "result.json") }));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ passed: false, requests, error: message.replaceAll(apiKey, "[redacted]") }));
  process.exitCode = 1;
} finally {
  await runtime?.close();
  apiKey = "";
}
