import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, type ToolResultMessage } from "@earendil-works/pi-ai";
import { hasTool, scriptedFixture, until } from "./helpers.js";

const call = (name: string, args: Record<string, unknown>) =>
  fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const value = (result: ToolResultMessage) => JSON.parse(result.content.filter(part => part.type === "text").map(part => part.text).join(""));

test("ordinary chat creates, reads, updates, disables and deletes a project Skill without a Goal", async t => {
  let phase = "create";
  let name = "";
  let version = "";
  const fixture = await scriptedFixture(context => {
    assert(hasTool(context, "skills_list"));
    assert(hasTool(context, "skill_create"));
    assert(hasTool(context, "skill_read"));
    assert(hasTool(context, "skill_update"));
    assert(hasTool(context, "skill_enable"));
    assert(hasTool(context, "skill_delete"));
    assert(!hasTool(context, "write"));
    const results = context.messages.filter((message): message is ToolResultMessage => message.role === "toolResult");
    for (const result of results) assert.equal(result.isError, false);
    const last = results.at(-1);
    if (phase === "create" && !results.some(result => result.toolName === "skill_create")) {
      return call("skill_create", { name: "invoice-helper", description: "Calculate invoice totals.", body: "1. Read the invoice.\\n2. Sum its amounts." });
    }
    if (phase === "read" && !results.some(result => result.toolName === "skill_read")) {
      return call("skill_read", { name });
    }
    if (phase === "update" && !results.some(result => result.toolName === "skill_update")) {
      return call("skill_update", { name, currentVersion: version, description: "Calculate invoice totals and cite rows.", body: "1. Read the invoice.\\n2. Sum its amounts.\\n3. Cite each row." });
    }
    if (phase === "disable" && !results.some(result => result.toolName === "skill_enable")) {
      return call("skill_enable", { name, enabled: false });
    }
    if (phase === "delete" && !results.some(result => result.toolName === "skill_delete")) {
      return call("skill_delete", { name, currentVersion: version });
    }
    if (last?.toolName === "skills_list") return fauxAssistantMessage("Skill catalogue read.");
    return fauxAssistantMessage("Skill change saved.");
  });
  t.after(() => fixture.close());
  const chat = await fixture.runtime.create("Manage the reusable invoice Skill.", fixture.workspace, [], { chat: true });
  const wait = () => until(() => fixture.runtime.status(chat.id), state => state.status === "answered" || state.status === "failed");
  let status = await wait();
  assert.equal(status.status, "answered");
  assert.equal(status.goal, undefined);
  const first = status.messages.find((message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === "skill_create")!;
  const created = value(first);
  name = created.skill.name;
  version = created.skill.version;
  assert.equal(created.skill.name, "invoice-helper");
  assert.match(await readFile(join(fixture.workspace, ".kada", "skills", name, "SKILL.md"), "utf8"), /Calculate invoice totals/);

  phase = "read";
  await fixture.runtime.followUp(chat.id, "Read the complete Skill.", "skill-read");
  status = await wait();
  assert.equal(status.status, "answered");
  const readResult = status.messages.find((message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === "skill_read")!;
  assert.match(value(readResult).content, /Sum its amounts/);

  phase = "update";
  await fixture.runtime.followUp(chat.id, "Update the Skill to cite rows.", "skill-update");
  status = await wait();
  assert.equal(status.status, "answered");
  const updated = value(status.messages.find((message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === "skill_update")!);
  version = updated.skill.version;
  assert.notEqual(version, created.skill.version);
  assert.match(await readFile(join(fixture.workspace, ".kada", "skills", name, "SKILL.md"), "utf8"), /Cite each row/);

  phase = "disable";
  await fixture.runtime.followUp(chat.id, "Disable the Skill for this project.", "skill-disable");
  status = await wait();
  assert.equal(status.status, "answered");
  assert.equal(value(status.messages.find((message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === "skill_enable")!).enabled, false);

  phase = "delete";
  await fixture.runtime.followUp(chat.id, "Delete the Skill.", "skill-delete");
  status = await wait();
  assert.equal(status.status, "answered");
  assert.equal(value(status.messages.find((message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === "skill_delete")!).deleted, true);
  await assert.rejects(readFile(join(fixture.workspace, ".kada", "skills", name, "SKILL.md")));
});
