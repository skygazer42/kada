import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:net";
import { once } from "node:events";
import { awaitWithContext, BACKGROUND_CONTEXT as ctx, withAbortSignal } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { JsonObject } from "@earendil-works/pi-durable";
import { serve } from "../src/server.js";
import { createClient } from "../src/client.js";
import { ChatSession } from "../src/chat.js";
import type { TaskView } from "../src/task-view.js";
import { hasTool, scriptedFixture, until } from "./helpers.js";

test("a worker question survives reopen and the same child accepts one owner answer", async () => {
  const call = (name: string, args: JsonObject) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
  let childAnswers = 0;
  let reports = 0;
  const questionVisible = Promise.withResolvers<number>();
  const requestInstructions = "Include a unit label.";
  const fixture = await scriptedFixture(async (conversation, signal) => {
    const users = conversation.messages.filter(message => message.role === "user");
    const results = conversation.messages.filter(message => message.role === "toolResult");
    if (!hasTool(conversation, "delegate_background")) {
      if (users.some(message => message.content === "Check the separate source.")) return fauxAssistantMessage("Independent sibling done.");
      if (users.some(message => String(message.content).includes(requestInstructions))) {
        assert(users.some(message => message.content === "Use the November totals."));
        return fauxAssistantMessage("Used the November totals, in USD.");
      }
      if (users.some(message => message.content === "Use the November totals.")) {
        childAnswers++;
        return fauxAssistantMessage("Used the November totals.");
      }
      return call("delegation_ask", { question: "Which month should I use?" });
    }
    assert.equal(hasTool(conversation, "delegation_ask"), false);
    if (users.some(message => String(message.content).startsWith("Background delegation finished."))) {
      reports++;
      return call("task_submit", { summary: "The November evidence is ready.", artifacts: [] });
    }
    if (!results.some(result => result.toolName === "delegate_background")) {
      return call("delegate_background", { tasks: [
        { name: "worker", instructions: "Check the totals." },
        { name: "independent worker", instructions: "Check the separate source." },
      ] });
    }
    if (!results.some(result => result.toolName === "task_submit")) {
      return call("task_submit", { summary: "Wrong early delivery.", artifacts: [] });
    }
    if (!results.some(result => result.toolName === "delegate_send")) {
      const childId = await awaitWithContext(questionVisible.promise, signal ? withAbortSignal(signal, ctx) : ctx);
      return call("delegate_send", { childId, instructions: requestInstructions });
    }
    assert.equal(results.find(result => result.toolName === "delegate_send")?.isError, false);
    return fauxAssistantMessage("Waiting for the worker.");
  });
  let daemon: Awaited<ReturnType<typeof serve>> | undefined;
  try {
    const task = await fixture.runtime.create("Verify the totals", fixture.workspace);
    const asked = await until(() => fixture.runtime.status(task.id), status => status.delegations[0]?.status === "waiting_input");
    questionVisible.resolve(asked.delegations[0]!.conversationId);
    const before = await until(() => fixture.runtime.status(task.id), status =>
      status.submission?.status === "done" && status.delegations[0]?.status === "waiting_input" && status.delegations[1]?.status === "completed", 15_000);
    const child = before.delegations[0]!;
    assert.equal(child.question?.text, "Which month should I use?");
    assert.equal(before.goal?.candidate, null);
    assert.equal(before.goal?.reworks, 0);
    await fixture.runtime.close();

    const probe = createServer().listen(0, "127.0.0.1");
    await once(probe, "listening");
    const address = probe.address();
    assert(address && typeof address !== "string");
    probe.close();
    await once(probe, "close");
    const settings = { ...fixture.settings, port: address.port };
    daemon = await serve(settings, { models: fixture.models });
    const reopened = daemon.runtime;
    const client = createClient(settings);
    const waiting = await reopened.status(task.id);
    assert.deepEqual(waiting.delegations[0]?.question, child.question);
    const desktop = await client.request<TaskView>(`/v1/tasks/${task.id}/view`);
    assert.deepEqual(desktop.delegations.filter(item => item.status === "waiting_input").map(item => ({
      conversationId: item.conversationId, name: item.name, question: item.question,
    })), [{ conversationId: child.conversationId, name: child.name, question: child.question }]);
    assert.equal((await reopened.list("pending"))[0]?.id, task.id);
    const output: string[] = [];
    const chat = new ChatSession(client, event => output.push(event.text));
    await chat.attach(task.id);
    assert.match(output.join("\n"), /Which month should I use/);
    const path = (childId: number) => `/v1/tasks/${task.id}/delegations/${childId}/questions/${child.question!.id}/answer`;
    const reply = { requestId: "terminal-" + child.question!.id, answer: "Use the November totals." };
    const unauthenticated = await fetch(`http://127.0.0.1:${settings.port}${path(child.conversationId)}`, { method: "POST" });
    assert.equal(unauthenticated.status, 401);
    await assert.rejects(client.request(path(waiting.delegations[1]!.conversationId), "POST", reply), /Child question not found/);
    // Preserve the boundary after the owner receipt and before Pi admits the reply.
    clearInterval(reopened["timer"]);
    await chat.handle(`/reply-child ${child.conversationId} ${child.question!.id} ${reply.answer}`);
    assert.match(output.join("\n"), /答复已接收/);
    assert.equal(childAnswers, 0);
    const saved = await client.request(path(child.conversationId), "POST", reply);
    assert.deepEqual(await client.request(path(child.conversationId), "POST", reply), saved);
    await assert.rejects(client.request(path(child.conversationId), "POST", { ...reply, answer: "Use the December totals." }), /different answer/);
    await daemon.close();
    daemon = await serve(settings, { models: fixture.models });
    const after = await until(() => daemon!.runtime.status(task.id), status => status.status === "completed");
    assert.equal(after.goal?.revision, before.goal?.revision);
    assert.equal(after.goal?.candidate?.summary, "The November evidence is ready.");
    assert.deepEqual(after.delegations.map(item => [item.conversationId, item.status, item.answer]),
      [[child.conversationId, "completed", "Used the November totals, in USD."],
        [waiting.delegations[1]!.conversationId, "completed", "Independent sibling done."]]);
    assert.equal(childAnswers, 1);
    assert.equal(reports, 1);
    assert(!(await client.request<TaskView>(`/v1/tasks/${task.id}/view`)).delegations.some(item => item.question));
  } finally {
    await daemon?.close();
    await fixture.close();
  }
});
