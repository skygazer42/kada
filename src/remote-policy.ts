import { copyFile, mkdir, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { AgentDoc, defineExtension, defineTool, hook, ToolTask, type Extension } from "@earendil-works/pi-durable";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import { acceptanceChecks } from "./checks.js";
import { localEnvironment } from "./execution.js";
import type { Workspace } from "./workspace.js";

const allowedTools = new Set([
  "read", "write", "edit", "read_file", "write_file", "list_files", "copy_file", "delegate",
  "task_prepare", "task_status", "task_plan", "task_checkpoint", "task_submit", "task_blocked", "review_result",
]);
const nativePath = (path: string) => path.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ").replace(/^@/, "");

/** A tool boundary for remote conversations, not an operating-system sandbox. */
export function remoteFilePolicy(workspace: Workspace): Extension {
  return defineExtension({ name: "remote_workspace_policy", hooks: [hook(ToolTask, {
    beforeTool: async (call, api, context) => {
      if (!allowedTools.has(call.name)) return { block: "This capability is unavailable to remote conversations." };
      const agent = await api.snapshot(AgentDoc, api.conversationId, context);
      if (!agent?.cwd) return { block: "The remote conversation has no workspace directory." };
      const cwd = await workspace.path(agent.cwd);
      const args = call.arguments;
      if (["read", "write", "edit"].includes(call.name)) {
        // Match Pi's @/Unicode-space aliases and environment expansion before checking the boundary.
        const input = nativePath(args.path as string);
        const absolute = getOrThrow(await localEnvironment(cwd).absolutePath(input, context));
        const path = await workspace.path(nativePath(absolute), cwd);
        if (call.name === "read") {
          for (const variant of [path.replace(/ (AM|PM)\./gi, "\u202F$1."), path.normalize("NFD"),
            path.replace(/'/g, "\u2019"), path.normalize("NFD").replace(/'/g, "\u2019")]) await workspace.path(variant, cwd);
        }
        return { arguments: { ...args, path } };
      }
      if (["read_file", "write_file", "list_files"].includes(call.name)) await workspace.path((args.path ?? ".") as string, cwd);
      if (call.name === "copy_file") {
        await workspace.path(args.source as string, cwd);
        await workspace.path(args.destination as string, cwd);
      }
      if (call.name === "task_prepare") {
        const criteria = args.criteria as { method: string; verification?: unknown }[];
        if (criteria.some((criterion) => criterion.method !== "inspect" || Object.hasOwn(criterion, "verification"))) {
          return { block: "Remote briefs support inspect criteria only; command verification is unavailable." };
        }
      }
      if (call.name === "task_prepare" || call.name === "task_plan") {
        const checks = acceptanceChecks(args.checks);
        for (const [index, check] of checks.entries()) {
          const raw = (args.checks as Record<string, unknown>[])[index]!;
          if (Object.keys(raw).some((key) => !Object.hasOwn(check, key))) return { block: "Remote acceptance checks cannot include executable fields." };
          await workspace.path(check.path, cwd);
        }
      }
      if (call.name === "task_submit") for (const path of args.artifacts as string[]) await workspace.path(path, cwd);
    },
  })] });
}

/** Selected only after the host confirms the task brief. */
export function remoteFileTools(workspace: Workspace): Extension {
  return defineExtension({ name: "remote_workspace_files", tools: [createReadTool(), createWriteTool(), createEditTool(),
    defineTool({
      name: "list_files", description: "List entries inside this conversation workspace, relative to your working directory.",
      parameters: Type.Object({ path: Type.Optional(Type.String()) }), replay: "safe",
      execute: async (args, api, context) => ({ output: [{ type: "text", text: (await workspace.list(args.path, (await api.agent(context)).cwd)).join("\n") }] }),
    }),
    defineTool({
      name: "copy_file", description: "Copy a regular workspace file byte-for-byte inside this conversation workspace. Preserves binary and empty files.",
      parameters: Type.Object({ source: Type.String({ minLength: 1 }), destination: Type.String({ minLength: 1 }) }),
      execute: async (args, api, context) => {
        const cwd = (await api.agent(context)).cwd;
        const source = await workspace.inspect(args.source, cwd);
        const destination = await workspace.path(args.destination, cwd);
        await mkdir(dirname(destination), { recursive: true });
        await workspace.path(destination);
        const temporary = join(dirname(destination), ".kada-copy-" + randomUUID());
        try {
          await copyFile(await workspace.path(source.path), temporary);
          const copied = await workspace.inspect(temporary);
          if (source.bytes !== copied.bytes || source.sha256 !== copied.sha256) throw new Error("The source changed while copying; inspect it before retrying.");
          await workspace.path(destination);
          await rename(temporary, destination);
        } finally { await rm(temporary, { force: true }); }
        return { output: [{ type: "text", text: "Copied " + destination }] };
      },
    }),
  ] });
}
