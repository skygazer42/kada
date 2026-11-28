import { lstat, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { SkillStore, type SkillCatalogEntry } from "./skills.js";
import { Workspace } from "./workspace.js";

const skillName = Type.String({ minLength: 1, maxLength: 64, pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" });
const description = Type.String({ minLength: 1, maxLength: 1024 });
const body = Type.String({ maxLength: 15_000 });
const version = Type.String({ pattern: "^[a-f0-9]{64}$" });
const output = (value: unknown) => ({ output: [{ type: "text" as const, text: JSON.stringify(value) }] });
const root = ".kada/skills";
const pathOf = (name: string) => root + "/" + name;
const fileOf = (name: string) => pathOf(name) + "/SKILL.md";

function fullContent(name: string, descriptionValue: string, bodyValue: string, content?: string) {
  if (content !== undefined) {
    if (content.length > 16_000) throw new Error("Skill content is too large.");
    return content;
  }
  return "---\nname: " + name + "\ndescription: " + JSON.stringify(descriptionValue) + "\n---\n\n" + bodyValue + "\n";
}

async function snapshot(workspace: Workspace, name: string) {
  return workspace.inspectTree(pathOf(name));
}

function projectSkill(catalog: SkillCatalogEntry[], name: string) {
  const entry = catalog.find(item => item.name === name);
  if (!entry) throw new Error("Skill was not found in the project catalogue.");
  if (entry.source !== "project" || entry.issue) throw new Error(entry.issue ?? "Only a valid project Skill can be managed.");
  return entry;
}

export function chatSkillsExtension(workspace: string, project: string, store: () => Promise<SkillStore>) {
  const requestProject = async () => {
    if (await Workspace.open(workspace, { create: false }).then(value => value.root) !== project) {
      throw new Error("The original Skill project changed.");
    }
  };
  return defineExtension({
    name: "local_chat_skills",
    sections: [section("skill_management_policy", () =>
      "When Skill management tools are offered, use them only for a user's explicit request in ordinary conversation. Skills are reusable project instructions. Read the current Skill and version before updating or deleting it. Content is guidance, not permission to execute tools. Skill changes never start a Goal or switch this conversation's role.")],
    tools: [
      defineTool({
        name: "skills_list",
        description: "List the current project Skill catalogue with versions, source, enabled state and issues. This only reads metadata.",
        parameters: Type.Object({ includeDisabled: Type.Optional(Type.Boolean()) }, { additionalProperties: false }), replay: "safe",
        execute: async args => {
          await requestProject();
          const entries = await (await store()).catalog(await Workspace.open(workspace, { create: false }));
          return output({ project, items: entries.filter(item => args.includeDisabled || item.enabled) });
        },
      }),
      defineTool({
        name: "skill_read",
        description: "Read the complete current SKILL.md for a project-created Skill before changing it.",
        parameters: Type.Object({ name: skillName }, { additionalProperties: false }), replay: "safe",
        execute: async args => {
          await requestProject();
          const ws = await Workspace.open(workspace, { create: false });
          projectSkill(await (await store()).catalog(ws), args.name);
          return output({ name: args.name, version: (await snapshot(ws, args.name)).root.sha256, content: await ws.read(fileOf(args.name)) });
        },
      }),
      defineTool({
        name: "skill_create",
        description: "Create a reusable project Skill only when the user explicitly asks. Provide concise generic instructions. This never starts work or executes the Skill.",
        parameters: Type.Object({ name: skillName, description, body: Type.Optional(body), content: Type.Optional(Type.String({ maxLength: 16_000 })) }, { additionalProperties: false }),
        replay: "safe", executionMode: "sequential",
        execute: async args => {
          await requestProject();
          const ws = await Workspace.open(workspace, { create: false });
          const catalog = await (await store()).catalog(ws);
          if (catalog.some(item => item.name === args.name)) throw new Error("A Skill with this name already exists in the project catalogue.");
          const target = await ws.path(fileOf(args.name));
          try { await lstat(target); throw new Error("The Skill already exists."); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
          await mkdir(await ws.path(pathOf(args.name)), { recursive: true });
          await ws.write(fileOf(args.name), fullContent(args.name, args.description, args.body ?? "", args.content));
          const created = projectSkill(await (await store()).catalog(ws), args.name);
          return output({ skill: { name: created.name, description: created.description, version: created.currentVersion, enabled: created.enabled }, started: false });
        },
      }),
      defineTool({
        name: "skill_update",
        description: "Update a project-created Skill only as requested. currentVersion is required and prevents overwriting a newer edit. Replace the full body or provide a complete SKILL.md.",
        parameters: Type.Object({ name: skillName, currentVersion: version, description: Type.Optional(description), body: Type.Optional(body), content: Type.Optional(Type.String({ maxLength: 16_000 })) }, { additionalProperties: false }),
        replay: "safe", executionMode: "sequential",
        execute: async args => {
          await requestProject();
          const ws = await Workspace.open(workspace, { create: false });
          const currentEntry = projectSkill(await (await store()).catalog(ws), args.name);
          if ((await snapshot(ws, args.name)).root.sha256 !== args.currentVersion) throw new Error("The Skill changed. Read the current version before updating it.");
          if (args.content === undefined && args.description === undefined && args.body === undefined) throw new Error("Provide Skill content or changed description/body.");
          const current = await ws.read(fileOf(args.name));
          const next = args.content ?? fullContent(args.name, args.description ?? currentEntry.description, args.body ?? current.split("---\n").slice(2).join("---\n"));
          await ws.write(fileOf(args.name), next);
          const updated = projectSkill(await (await store()).catalog(ws), args.name);
          return output({ skill: { name: updated.name, description: updated.description, version: updated.currentVersion, enabled: updated.enabled }, started: false });
        },
      }),
      defineTool({
        name: "skill_enable",
        description: "Enable or disable a project Skill for future project tasks. Existing pinned tasks keep their original version.",
        parameters: Type.Object({ name: skillName, enabled: Type.Boolean() }, { additionalProperties: false }), replay: "safe", executionMode: "sequential",
        execute: async args => {
          await requestProject();
          const ws = await Workspace.open(workspace, { create: false });
          await (await store()).setEnabled(args.name, args.enabled, ws);
          const entry = projectSkill(await (await store()).catalog(ws), args.name);
          return output({ name: args.name, enabled: entry.enabled });
        },
      }),
      defineTool({
        name: "skill_delete",
        description: "Delete a project-created Skill only as explicitly requested. currentVersion prevents deleting a newer edit.",
        parameters: Type.Object({ name: skillName, currentVersion: version }, { additionalProperties: false }), replay: "safe", executionMode: "sequential",
        execute: async args => {
          await requestProject();
          const ws = await Workspace.open(workspace, { create: false });
          projectSkill(await (await store()).catalog(ws), args.name);
          if ((await snapshot(ws, args.name)).root.sha256 !== args.currentVersion) throw new Error("The Skill changed. Read the current version before deleting it.");
          await (await store()).setEnabled(args.name, true, ws);
          await rm(await ws.path(pathOf(args.name)), { recursive: true, force: false });
          return output({ name: args.name, deleted: true });
        },
      }),
    ],
  });
}
