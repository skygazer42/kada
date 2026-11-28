import { lstat, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSkills, formatSkillsForPrompt, type Skill } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, wrapTool } from "@earendil-works/pi-durable";
import { createReadTool } from "@earendil-works/pi-durable/tools";
import { GoalDoc, plain, type GoalState } from "./goal.js";
import { confirmedProof } from "./verification.js";
import { Workspace } from "./workspace.js";
import { errorText, SerialQueue } from "./util.js";
import type { LocalSkill } from "./discovery.js";

export type SkillPin = { name: string; description: string; filePath: string; version: string; managed: boolean };
export type SkillState = { pins: SkillPin[]; loaded: string[]; executions?: SkillExecution[]; proposal?: { name: string; version: string }; settledRevision?: number; notice?: string };
type Head = { version: string; previous?: string; published: string[]; disabled?: boolean };
const bundled = fileURLToPath(new URL("../skills", import.meta.url));
const projectSources = (root: string) => [".pi", ".agents", ".claude", ".codex", ".cursor", ".opencode", ".gemini", ".kada"].map(dir => join(root, dir, "skills"));
const validName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const key = (pin: { name: string; version: string }) => `${pin.name}@${pin.version}`;
export type SkillSelection = { name: string; version?: string };
export type SkillExecution = { name: string; version: string; path: string; sha256: string; ok: boolean; durationMs: number };
export type SkillCatalogEntry = {
  name: string;
  description: string;
  source: "project" | "user" | "bundled" | "managed";
  currentVersion?: string;
  versions: string[];
  enabled: boolean;
  issue?: string;
  shadowed?: SkillCatalogEntry["source"][];
};
type Candidate = { entry: SkillCatalogEntry; versions: Map<string, Skill> };
type DisabledSkills = Record<string, string[]>;

async function authoredCandidates(workspace: Workspace, disabled: string[] = [], discovered: LocalSkill[] = []): Promise<Candidate[]> {
  const roots: { path: string; source: SkillCatalogEntry["source"]; disabled?: boolean }[] = [
    ...projectSources(workspace.root).map(path => ({ path, source: "project" as const })),
    ...discovered.map(skill => ({ path: skill.path, source: "user" as const, disabled: skill.disabled })),
    { path: bundled, source: "bundled" },
  ];
  return (await Promise.all(roots.map(async root => {
    const parsed = load(workspace.root, [root.path]);
    return Promise.all(parsed.skills.filter(skill => validName.test(skill.name)).map(async skill => {
      const entry: SkillCatalogEntry = {
        name: skill.name, description: skill.description, source: root.source, versions: [], enabled: !disabled.includes(skill.name),
      };
      const versions = new Map<string, Skill>();
      try {
        const { root: snapshot } = await tree(await Workspace.open(skill.baseDir, { create: false }), ".");
        entry.currentVersion = snapshot.sha256;
        entry.versions.push(snapshot.sha256);
        versions.set(snapshot.sha256, skill);
      } catch {
        entry.issue = "Skill files are unavailable or exceed the size limits.";
      }
      if (root.disabled) entry.issue = "The originating Agent has disabled this Skill.";
      if (skill.disableModelInvocation) entry.issue = "The Skill disables model invocation.";
      entry.enabled &&= entry.issue === undefined;
      return { entry, versions };
    }));
  }))).flat();
}

function withoutCollisions(candidates: Candidate[]): Candidate[] {
  const unique = new Map<string, Candidate>();
  for (const candidate of candidates) {
    const previous = unique.get(candidate.entry.name);
    if (previous) {
      (previous.entry.shadowed ??= []).push(candidate.entry.source);
    } else {
      unique.set(candidate.entry.name, candidate);
    }
  }
  return [...unique.values()];
}
const contains = (parent: string, child: string) => child === parent || child.startsWith(parent + sep);
const load = (cwd: string, paths: string[]) => loadSkills({ cwd, agentDir: join(cwd, ".pi"), skillPaths: paths, includeDefaults: false });

/** File bounds protect this optional local catalogue; native Pi handles parsing and routing. */
async function tree(workspace: Workspace, path: string) {
  const value = await workspace.inspectTree(path);
  if (!("kind" in value.root) || value.files.length > 16 || value.root.bytes > 131072 ||
    value.files.some(f => f.bytes > 32768) || !value.files.some(f => f.path === join(value.root.path, "SKILL.md") && f.bytes <= 8192)) {
    throw new Error("A local Skill needs SKILL.md (at most 8 KiB), at most 16 UTF-8 files / 128 KiB total");
  }
  return value;
}
async function copy(workspace: Workspace, path: string, destination: string, version: string) {
  const original = await tree(workspace, path), target = await Workspace.open(destination);
  if (original.root.sha256 !== version) throw new Error("Skill version changed");
  for (const directory of original.directories) {
    await mkdir(await target.path(relative(original.root.path, directory)), { recursive: true });
  }
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  for (const file of original.files) {
    const { data } = await workspace.readBinarySnapshot(file.path, 32768);
    if (data.includes(0)) throw new Error("Skill files must contain UTF-8 text");
    await target.write(relative(original.root.path, file.path), decoder.decode(data));
  }
  if ((await tree(workspace, path)).root.sha256 !== version || (await tree(target, ".")).root.sha256 !== version) throw new Error("Skill changed while pinning");
  return target;
}

function nativeSkill(workspace: Workspace, directory: string) {
  const parsed = load(workspace.root, [directory]);
  const skill = parsed.skills[0];
  if (parsed.skills.length !== 1 || !skill || parsed.diagnostics.length || skill.filePath !== join(directory, "SKILL.md") ||
    !validName.test(skill.name) || skill.name.length > 64 || skill.description.length > 1024 || skill.disableModelInvocation) {
    throw new Error("Use one valid native Pi SKILL.md with name and description");
  }
  return skill;
}

/** Only version heads/provenance are custom. No keyword index, memory service or model call. */
export class SkillStore {
  private changes = new SerialQueue();
  private constructor(readonly files: Workspace) {}
  static async open(dataDir: string) {
    const path = join(dataDir, "skills", "managed");
    await mkdir(path, { recursive: true, mode: 0o700 });
    return new SkillStore(await Workspace.open(path));
  }
  private async heads(): Promise<Record<string, Head>> {
    try { return JSON.parse(await this.files.read("heads.json")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
  }
  static async existing(dataDir: string): Promise<SkillStore | undefined> {
    try {
      return new SkillStore(await Workspace.open(join(dataDir, "skills", "managed"), { create: false }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }

  private async disabled(): Promise<DisabledSkills> {
    try {
      return JSON.parse(await this.files.read("disabled.json")) as DisabledSkills;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }

  async candidates(workspace: Workspace, discovered: LocalSkill[] = []): Promise<Candidate[]> {
    const disabled = (await this.disabled())[workspace.root] ?? [];
    const authored = await authoredCandidates(workspace, disabled, discovered);
    const heads = await this.heads();
    for (const [name, head] of Object.entries(heads)) {
      if (!validName.test(name)) continue;
      const entry: SkillCatalogEntry = {
        name, description: "", source: "managed", currentVersion: head.version,
        versions: [], enabled: !head.disabled && !disabled.includes(name),
      };
      const versions = new Map<string, Skill>();
      for (const version of head.published) {
        if (!/^[0-9a-f]{64}$/.test(version)) continue;
        try {
          const dir = join(this.files.root, name, version);
          const snapshot = await tree(await Workspace.open(dir, { create: false }), ".");
          const [skill] = load(workspace.root, [dir]).skills;
          if (snapshot.root.sha256 !== version || skill?.name !== name || skill.disableModelInvocation) continue;
          versions.set(version, skill);
          entry.versions.push(version);
          if (version === head.version) entry.description = skill.description;
        } catch (error) {
          if (version === head.version) entry.issue = "Current published Skill files are missing or changed.";
        }
      }
      if (!versions.has(head.version)) entry.issue = "Current published Skill files are missing or changed.";
      entry.enabled &&= entry.issue === undefined;
      authored.push({ entry, versions });
    }
    return withoutCollisions(authored);
  }

  async catalog(workspace: Workspace, discovered: LocalSkill[] = []): Promise<SkillCatalogEntry[]> {
    return (await this.candidates(workspace, discovered)).map(({ entry }) => entry).sort((a, b) => a.name.localeCompare(b.name));
  }

  async setEnabled(name: string, enabled: boolean, workspace: Workspace, discovered: LocalSkill[] = []): Promise<void> {
    await this.changes.run(async () => {
      const candidate = (await this.candidates(workspace, discovered)).find(({ entry }) => entry.name === name);
      if (!candidate) throw new Error(`Unknown Skill: ${name}`);
      if (enabled && candidate.entry.issue) throw new Error(candidate.entry.issue);
      const disabled = await this.disabled();
      const names = new Set(disabled[workspace.root] ?? []);
      if (enabled) names.delete(name);
      else names.add(name);
      disabled[workspace.root] = [...names].sort();
      await this.files.write("disabled.json", JSON.stringify(disabled, null, 2));
      if (enabled && candidate.entry.source === "managed") {
        const heads = await this.heads();
        const head = heads[name];
        if (head?.disabled) {
          head.disabled = false;
          await this.files.write("heads.json", JSON.stringify(heads, null, 2));
        }
      }
    });
  }

  async paths(): Promise<string[]> {
    const paths: string[] = [];
    for (const [name, head] of Object.entries(await this.heads())) {
      if (!validName.test(name) || name.length > 64 || !/^[a-f0-9]{64}$/.test(head.version) || head.disabled) continue;
      const path = join(this.files.root, name, head.version);
      try { if ((await tree(this.files, path)).root.sha256 === head.version) paths.push(path); } catch { /* Optional corrupted trials are skipped. */ }
    }
    return paths;
  }
  private async recordVersion(heads: Record<string, Head>, ref: { name: string; version: string }, source: unknown) {
    const old = Object.hasOwn(heads, ref.name) ? heads[ref.name] : undefined;
    if (old?.published.includes(ref.version)) return;
    if ((!old && Object.keys(heads).length >= 32) || (old?.published.length ?? 0) >= 32) throw new Error("Local Skill catalogue/revision limit reached");
    await this.files.write(`${ref.name}/${ref.version}.source.json`, JSON.stringify(source));
    heads[ref.name] = { version: ref.version, published: [...(old?.published ?? []), ref.version], ...(old && !old.disabled ? { previous: old.version } : {}) };
    await this.files.write("heads.json", JSON.stringify(heads));
  }

  async importVersion(workspace: Workspace, path: string, expectedVersion?: string, discovered: LocalSkill[] = []) {
    const candidate = await tree(workspace, path);
    const skill = nativeSkill(workspace, candidate.root.path);
    const ref = { name: skill.name, version: candidate.root.sha256 };
    const authored = load(workspace.root, [...projectSources(workspace.root), ...discovered.map(item => item.path), bundled]);
    if (authored.skills.some(item => item.name === ref.name)) throw new Error("Managed Skills cannot replace authored Skills");
    return this.changes.run(async () => {
      const heads = await this.heads();
      const old = Object.hasOwn(heads, ref.name) ? heads[ref.name] : undefined;
      if (old?.published.includes(ref.version)) return ref;
      if (old?.version !== expectedVersion) throw new Error("The Skill changed. Provide its current version before importing.");
      await copy(workspace, candidate.root.path, join(this.files.root, ref.name, ref.version), ref.version);
      await this.recordVersion(heads, ref, { status: "owner import", workspace: workspace.root, path: candidate.root.path });
      return ref;
    });
  }

  async exportVersion(workspace: Workspace, ref: { name: string; version: string }, path: string, discovered: LocalSkill[] = []) {
    return this.changes.run(async () => {
      const candidate = (await this.candidates(workspace, discovered)).find(({ entry }) => entry.name === ref.name);
      const skill = candidate?.versions.get(ref.version);
      if (!skill) throw new Error("Choose an available Skill version from the current catalogue");
      const target = await workspace.path(path);
      let existing;
      try { existing = await lstat(target); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const result = { ...ref, path: target };
      if (existing) {
        const current = existing.isDirectory() ? await workspace.inspectTree(target) : null;
        if (current?.root.sha256 === ref.version) return result;
        throw new Error("The export destination already exists with different content");
      }
      await mkdir(dirname(target), { recursive: true });
      const stage = await workspace.path(await mkdtemp(target + '.export-'));
      try {
        const source = await Workspace.open(skill.baseDir, { create: false });
        await copy(source, ".", stage, ref.version);
        await workspace.path(target);
        await rename(stage, target);
      } finally { await rm(stage, { recursive: true, force: true }); }
      return result;
    });
  }

  async capture(workspace: Workspace, goal: GoalState, taskId: string, path: string) {
    if (goal.phase !== "completed") throw new Error("Skills are saved only after successful delivery");
    const candidate = await tree(workspace, path);
    const proofIds = [...new Set(goal.candidate?.criteria?.flatMap(c => c.proofIds ?? []) ?? [])];
    let proofId: string | undefined;
    for (const id of proofIds) try {
      const proof = await confirmedProof(goal, workspace, id);
      if (proof.outputs.some(p => "kind" in p && p.kind === "directory" && contains(p.path, candidate.root.path))) { proofId = id; break; }
    } catch { /* Other receipts may describe unrelated or stale work. */ }
    if (!proofId) throw new Error("Skill directory must belong to a fresh, frozen verified output");
    const skill = nativeSkill(workspace, candidate.root.path);
    const ref = { name: skill.name, version: candidate.root.sha256 };
    const authored = load(workspace.root, [...projectSources(workspace.root), bundled]);
    if (authored.skills.some(s => s.name === ref.name)) throw new Error("Managed Skills cannot replace authored Skills");
    await copy(workspace, candidate.root.path, join(this.files.root, ref.name, ref.version), ref.version);
    await confirmedProof(goal, workspace, proofId);
    await this.changes.run(async () => {
      await this.recordVersion(await this.heads(), ref, { taskId, proofId, inputHashes: goal.proofs![proofId]!.inputs,
        status: "local trial; passing the source check is not proof of future quality or savings" });
    });
    return ref;
  }
  async rollback(ref: { name: string; version: string }) {
    await this.changes.run(async () => {
      const heads = await this.heads(), head = heads[ref.name];
      if (!head || head.version !== ref.version) return;
      heads[ref.name] = head.previous ? { version: head.previous, published: head.published } : { ...head, disabled: true };
      await this.files.write("heads.json", JSON.stringify(heads));
    });
  }
}

/** Authored first, generated second (Oh My Pi's managed/authored separation). */
export async function pinSkills(workspace: Workspace, directory: string, store?: SkillStore, selection?: SkillSelection[], discovered: LocalSkill[] = []): Promise<SkillState> {
  const candidates = store ? await store.candidates(workspace, discovered) : withoutCollisions(await authoredCandidates(workspace, [], discovered));
  if (selection && (selection.length > 16 || new Set(selection.map(item => item.name)).size !== selection.length)) {
    throw new Error("Select at most 16 different Skills.");
  }
  const requested: SkillSelection[] = selection ?? candidates.filter(({ entry }) => entry.enabled).slice(0, 16).map(({ entry }) => ({ name: entry.name }));
  const selected = requested.map(ref => {
    const candidate = candidates.find(({ entry }) => entry.name === ref.name);
    if (!candidate) throw new Error(`Unknown Skill: ${ref.name}`);
    const { entry, versions } = candidate;
    if (!entry.enabled) throw new Error(`Skill ${ref.name}: ${entry.issue ?? "disabled"}`);
    const version = ref.version ?? entry.currentVersion;
    if (!version) throw new Error(`Skill ${ref.name} version is unavailable or changed.`);
    const skill = versions.get(version);
    if (!skill) throw new Error(`Skill ${ref.name} version is unavailable or changed.`);
    return { skill, version, managed: entry.source === "managed" };
  });
  const pins: SkillPin[] = [];
  const notices = candidates.flatMap(({ entry }) => [
    ...(entry.issue ? [`${entry.name}: ${entry.issue}`] : []),
    ...(entry.shadowed?.length ? [`${entry.name}: using the first ${entry.source} source; ${entry.shadowed.join(", ")} source(s) have the same name`] : []),
  ]);
  for (const { skill, version, managed } of selected) try {
    if (skill.disableModelInvocation) continue;
    if (!validName.test(skill.name) || skill.name.length > 64 || skill.description.length > 1024 || skill.filePath !== join(skill.baseDir, "SKILL.md")) throw new Error("Use a standard SKILL.md with a valid name and description");
    const source = await Workspace.open(skill.baseDir, { create: false });
    const target = await copy(source, ".", join(directory, "skills", skill.name, version), version);
    pins.push({ name: skill.name, description: skill.description, filePath: join(target.root, "SKILL.md"), version, managed });
  } catch (error) {
    if (selection) throw new Error(`Skill ${skill.name}: ${errorText(error)}`);
    notices.push(`${skill.name}: ${errorText(error)}`);
  }
  if (selection === undefined && candidates.filter(({ entry }) => entry.enabled).length > 16) notices.push("Skill catalogue limited to 16; consolidate unused Skills");
  return { pins, loaded: [], ...(notices.length ? { notice: notices.join("; ").slice(0, 1000) } : {}) };
}
export function skillInstructions(state?: SkillState, capture = false): string {
  const skills: Skill[] = state?.pins.map(pin => ({ ...pin, baseDir: dirname(pin.filePath), disableModelInvocation: false,
    sourceInfo: { path: pin.filePath, baseDir: dirname(pin.filePath), source: "path", scope: "temporary", origin: "top-level" } })) ?? [];
  return (capture ? "\nLocal trial capture is optional: only for a useful new reusable script/workflow in recurring work, write a short standard SKILL.md (name/description frontmatter, applicability/limits, relative script paths) with its reusable files under an authorized output directory BEFORE the final check. Pass that directory as task_submit.skill. Skip duplicates and one-off work; no reflection turn or extra task. A saved trial is not a quality or savings claim.\n" : "") +
    (state?.pins.some(p => p.managed) ? "\nGenerated Skills are local trials. Recheck applicability/current inputs and run current task checks; they never grant permissions or override requirements.\n" : "") +
    (state?.pins.length ? "\nFor scripts from pinned Skills, first read that pin's SKILL.md. Then call run_skill_script with the Skill name, script path relative to the Skill, and args. This records the exact version and result.\n" : "") +
    formatSkillsForPrompt(skills, "read");
}

/** Observe native reads without adding a learning tool or changing read's output/schema. */
const scriptInterpreters: Record<string, string> = { sh: "bash", js: "node", mjs: "node", cjs: "node", py: "python" };
const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

export const runSkillScript = defineTool({
  name: "run_skill_script",
  description: "Use this tool for scripts from a pinned Skill so the task records the exact script and its result. Read the pinned SKILL.md for instructions first.",
  parameters: Type.Object({
    name: Type.String({ maxLength: 64 }),
    path: Type.String({ maxLength: 512 }),
    args: Type.Optional(Type.Array(Type.String({ maxLength: 4096 }), { maxItems: 32 })),
  }),
  replay: "unsafe",
  executionMode: "sequential",
  execute: async ({ name, path, args }, api, ctx) => {
    const state = await api.commit(async tx => plain((await tx.doc(GoalDoc)).skills ?? null), ctx);
    const pin = state?.pins.find(entry => entry.name === name);
    if (!pin) throw new Error("Select and pin the Skill before running its scripts.");
    if (!state?.loaded.includes(key(pin))) throw new Error("Read the pinned SKILL.md before running its scripts.");
    const parts = path.split("/");
    if (parts.some(part => !part || part === "." || part === ".." || /[:\\\x00-\x1f]/.test(part))) {
      throw new Error("Use a relative script path inside the pinned Skill.");
    }
    const extension = /\.([a-z]+)$/.exec(path)?.[1];
    const interpreter = extension && Object.hasOwn(scriptInterpreters, extension) ? scriptInterpreters[extension] : undefined;
    if (!interpreter) throw new Error("Use a .sh, .js, .mjs, .cjs or .py script from the pinned Skill.");
    const source = await Workspace.open(dirname(pin.filePath), { create: false });
    const snapshot = (await tree(source, ".")).root;
    if (snapshot.sha256 !== pin.version) throw new Error("Pinned Skill changed. Recheck its source before running it.");
    const script = await source.inspect(path);
    const absolute = join(source.root, ...parts).split(sep).join("/");
    const command = [interpreter, "--", shellQuote(absolute), ...(args ?? []).map(shellQuote)].join(" ");
    const started = Date.now();
    let ok = false;
    try {
      const result = await api.executeTool("bash", { command, timeout: 60 }, ctx, { key: "pinned-skill-script", progress: false });
      if ((await tree(source, ".")).root.sha256 !== pin.version) throw new Error("Pinned Skill changed while running. Inspect its output before retrying.");
      const nested = result.structuredOutput;
      const shell = nested && typeof nested === "object" && !Array.isArray(nested) ? nested : undefined;
      const output = typeof nested === "string" ? nested : typeof shell?.output === "string" ? shell.output : JSON.stringify(nested ?? "");
      ok = !result.isError && (typeof shell?.exitCode !== "number" || shell.exitCode === 0);
      return { output: [{ type: "text", text: output }], isError: !ok };
    } finally {
      await api.commit(async tx => {
        const skills = (await tx.doc(GoalDoc)).skills;
        if (!skills) return;
        skills.executions ??= [];
        skills.executions.push({ name, version: pin.version, path, sha256: script.sha256, ok, durationMs: Date.now() - started });
      }, ctx);
    }
  },
});

export function skillReads(external: LocalSkill[] = []) {
  return defineExtension({ name: "local_skills", wraps: [wrapTool(createReadTool(), tool => ({ ...tool,
    execute: async (args, api, ctx) => {
      const state = await api.commit(async tx => plain((await tx.doc(GoalDoc)).skills ?? null), ctx);
      const path = resolve((await api.agent(ctx)).cwd ?? ".", args.path);
      const pin = state?.pins.find(p => p.filePath === path);
      const discovered = external.find(s => s.path === path);
      const source = discovered ? await Workspace.open(dirname(path), { create: false }) : undefined;
      const original = source ? await source.inspect(path) : undefined;
      if (pin && (await tree(await Workspace.open(dirname(path)), ".")).root.sha256 !== pin.version) throw new Error("Pinned Skill changed; continue without this optional Skill");
      const result = await tool.execute(args, api, ctx);
      if (source && original && (await source.inspect(path)).sha256 !== original.sha256) throw new Error("External Skill changed while reading; inspect again");
      if (pin && !result.isError) await api.commit(async tx => {
        const skills = (await tx.doc(GoalDoc)).skills;
        if (skills && !skills.loaded.includes(key(pin))) skills.loaded.push(key(pin));
      }, ctx);
      if (original && !result.isError) await api.commit(async tx => {
        const goal = await tx.doc(GoalDoc);
        goal.localSkillReads ??= [];
        if (!goal.localSkillReads.some(r => r.path === path && r.sha256 === original.sha256)) goal.localSkillReads.push({ path, sha256: original.sha256 });
      }, ctx);
      return result;
    },
  }))] });
}

/** Called at the existing completion boundary. No follow-up input or model request. */
export async function settleSkills(store: SkillStore | undefined, workspace: Workspace, taskId: string, goal: GoalState) {
  const state = goal.skills;
  if (!state || state.settledRevision === goal.revision) return;
  const result: Pick<SkillState, "proposal" | "notice"> = {};
  if (store && goal.phase === "completed" && goal.candidate?.skill) try {
    result.proposal = await store.capture(workspace, goal, taskId, goal.candidate.skill);
  } catch (error) { result.notice = `Optional Skill capture skipped: ${errorText(error)}`; }
  return result;
}
