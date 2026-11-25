import { constants } from "node:fs";
import { copyFile, mkdir, open, realpath, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";
import { Type } from "@earendil-works/pi-ai";
import { defineDoc, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { GoalDoc, plain } from "./goal.js";
import { atomicJson, readJson, SerialQueue } from "./util.js";
import { allowedMemoryPath, claudeProject, memoryProject, memorySources, type MemoryDomain, type MemoryProvider } from "./memory-sources.js";
import type { LocalInventory } from "./discovery.js";

type Category = "preferences" | "work" | "projects" | "environment" | "life" | "notes";
type Source = { id: string; path: string; kind: "guidance" | "memory" | "environment" | "user"; scope: "global" | "project"; sha256: string; text: string; observedAt: number; provider?: MemoryProvider; domain?: MemoryDomain; project?: string; snapshot?: string; original?: string };
type Citation = { sourceId: string; path: string; sha256: string; quote: string; observedAt: number; snapshot?: string };
export type UserFact = { id: string; text: string; category: Category; scope: "global" | "project"; domain?: MemoryDomain; project?: string; certainty: "stated" | "inferred"; origin: "imported" | "organized"; state: "active" | "stale" | "superseded" | "forgotten"; evidence: Citation[]; supersedes?: string[]; updatedAt: number };
type MemoryCandidate = { id: string; project: string; taskId: string; fact: UserFact; sources: Source[];
  replaces: Record<string, string>; createdAt: number; status: "pending" | "accepted" | "rejected" };
export type UserMemory = { schema: 1; home: string; updatedAt: number; sources: Source[]; facts: UserFact[]; notices: string[];
  operations?: Record<string, MemoryReceipt>; candidates?: MemoryCandidate[] };
export type MemoryContext = { home: string; profile: string; evidence: string; summary: string; facts: number; sources: number; project?: string; captureEnabled?: boolean; references?: MemoryReference[];selectionId?:string };
export type MemoryFactView = UserFact & { revision: string };
export type MemoryReference = { factId: string; revision: string; scope: "global" | "project"; project?: string; sourceHash: string; text: string; evidence: Citation[] };
export type MemoryChange = { action: "correct" | "forget"; text?: string; expectedRevision: string; requestId: string };
export type MemoryChangeResult = { id: string; revision: string; state: UserFact["state"]; scope: UserFact["scope"]; project?: string; affectedIds: string[] };
type MemoryReceipt = { inputHash: string; result: MemoryChangeResult };
function validSource(source: Source): boolean {
  return !!source && (source.id === "environment" || /^[a-f0-9]{16}$/.test(source.id)) && typeof source.path === "string" &&
    typeof source.text === "string" && source.text.length <= 1048576 && /^[a-f0-9]{64}$/.test(source.sha256) &&
    ["guidance", "memory", "environment", "user"].includes(source.kind) && ["global", "project"].includes(source.scope) && Number.isFinite(source.observedAt);
}
function validFact(fact: UserFact): boolean {
  return !!fact && typeof fact.id === "string" && typeof fact.text === "string" && fact.text.length <= 640 && categories.includes(fact.category) &&
    ["global", "project"].includes(fact.scope) && ["stated", "inferred"].includes(fact.certainty) && ["imported", "organized"].includes(fact.origin) &&
    ["active", "stale", "superseded", "forgotten"].includes(fact.state) && Number.isFinite(fact.updatedAt) &&
    Array.isArray(fact.evidence) && fact.evidence.length > 0 && fact.evidence.every(evidence => evidence && typeof evidence.sourceId === "string" &&
      typeof evidence.path === "string" && typeof evidence.quote === "string" && /^[a-f0-9]{64}$/.test(evidence.sha256) && Number.isFinite(evidence.observedAt));
}
export type MemoryUseState = { initialized: boolean; current: string[]; references: MemoryReference[]; summary: string; updatedAt: number; prepared?:Record<string,{summary:string;references:MemoryReference[]}> };
export const MemoryUseDoc = defineDoc<MemoryUseState>({
  scope: "conversation", kind: "local.memory_use", version: 1, history: "latest", fork: "current",
  initial: () => ({ initialized: false, current: [], references: [], summary: "", updatedAt: 0 }),
  checkpointWhen: () => true,
});
export class MemoryMutationError extends Error {
  constructor(readonly status: number, message: string, readonly current?: MemoryFactView) { super(message); }
}
export function memoryRevision(fact: UserFact): string {
  return hash(JSON.stringify({
    id: fact.id, text: fact.text, scope: fact.scope, project: fact.project, domain: fact.domain,
    category: fact.category, certainty: fact.certainty, origin: fact.origin, state: fact.state,
    evidence: fact.evidence.map(item => [item.sourceId, item.sha256, item.quote]).sort(),
    supersedes: fact.supersedes,
  }));
}
function memoryReference(fact: UserFact): MemoryReference {
  return {
    factId: fact.id, revision: memoryRevision(fact), scope: fact.scope,
    ...(fact.project ? { project: fact.project } : {}),
    sourceHash: hash(JSON.stringify(fact.evidence.map(item => [item.sourceId, item.sha256, item.quote]).sort())),
    text: fact.text, evidence: fact.evidence,
  };
}
export function memorySelectionId(references:MemoryReference[]) {
  return hash(JSON.stringify(references.map(reference=>[reference.factId,reference.revision]).sort()));
}
function suppliedReferences(value:UserMemory,selected:UserFact[]) {
  return selected.flatMap(fact=>value.facts.filter(original=>original.state==='active' && factKey(original)===factKey(fact) && original.evidence.some(item=>fact.evidence.some(merged=>merged.sourceId===item.sourceId && merged.sha256===item.sha256))).map(memoryReference));
}
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const categories: Category[] = ["preferences", "work", "projects", "environment", "life", "notes"];
const domains: MemoryDomain[] = ["general", "work", "life", "unknown"];
const domainHeadings: Record<MemoryDomain, string> = { general: "通用", work: "工作", life: "个人生活", unknown: "待分类" };
const headings: Record<Category, string> = { preferences: "协作与偏好", work: "工作背景", projects: "项目线索", environment: "工作环境", life: "个人生活", notes: "其他线索" };
const token = /\b(?:sk-[a-z0-9_-]{16,}|(?:gh[pousr]|github_pat|xox[baprs])[_-][a-z0-9_-]{12,}|AIza[a-z0-9_-]{16,})\b/i;
const credential = /(?:api[ _-]?key|access[ _-]?key|secret|token|password|authorization|credential|密钥|密码)["'`]?\s*[=:：]|\bbearer\s+\S+|https?:\/\/[^\s/@]+:[^\s/@]+@/i;
const MAX_FACTS = 16000, MAX_SOURCES = 512, MAX_TOTAL_BYTES = 8 * 1024 * 1024;

/** A redacted snapshot is traceable but is not claimed to be the original bytes. */
function redact(text: string): string {
  let privateKey = false;
  return text.split(/\r?\n/).map(line => {
    if (/-----BEGIN .*PRIVATE KEY-----/.test(line)) privateKey = true;
    if (privateKey) { if (/-----END .*PRIVATE KEY-----/.test(line)) privateKey = false; return "[凭据内容已省略]"; }
    return token.test(line) || credential.test(line) ? "[凭据内容已省略]" : line;
  }).join("\n");
}
function category(text: string): Category {
  if (/个人生活|家庭|家人|健康|饮食|旅行|爱好|兴趣|生活习惯|personal life|family|health|hobb(?:y|ies)/i.test(text)) return "life";
  if (/偏好|协作|风格|回复|回答|沟通|语言|preference|communication|respond|reply|style/i.test(text)) return "preferences";
  if (/项目|project|repository|repo\b|workspace/i.test(text)) return "projects";
  if (/工作|职业|职位|担任|从事|profession|occupation|career/i.test(text)) return "work";
  return "notes";
}
function factDomain(category: Category, text: string, source?: Source): MemoryDomain {
  if (source?.domain) return source.domain;
  if (category === "life") return "life";
  if (source?.scope === "project" || category === "work" || category === "projects" || category === "environment") return "work";
  if (category === "preferences" && /回复|回答|答复|语言|沟通|沟通风格|交付|核验|respond|reply|language|communication|deliver|verif/i.test(text)) return "general";
  // An assistant's name alone cannot tell whether a note is about work or private life.
  return "unknown";
}
function citation(source: Source, quote: string): Citation {
  return { sourceId: source.id, path: source.path, sha256: source.sha256, quote, observedAt: source.observedAt, ...(source.snapshot ? { snapshot: source.snapshot } : {}) };
}
function imported(source: Source): UserFact[] {
  const facts: UserFact[] = []; let heading = "", code = false, paragraph: string[] = [];
  const emit = () => {
    const text = paragraph.join("\n").trim(); paragraph = [];
    if (!text || text.includes("[凭据内容已省略]")) return;
    for (let offset = 0; offset < text.length; offset += 640) {
      const quote = text.slice(offset, offset + 640).trim(); if (!quote) continue;
      const cat = source.kind === "environment" ? "environment" : category(`${heading}\n${quote}`);
      facts.push({ id: hash(`${source.id}:${quote}`).slice(0, 24), text: quote, category: cat, domain: factDomain(cat, `${heading}\n${quote}`, source),
        scope: source.scope, ...(source.project ? { project: source.project } : {}), certainty: source.kind === "memory" ? "inferred" : "stated", origin: "imported", state: "active", evidence: [citation(source, quote)], updatedAt: source.observedAt });
    }
  };
  const body = source.text.replace(/^---\n[\s\S]*?\n---(?:\n|$)/, "");
  for (const line of body.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) { emit(); code = !code; continue; }
    if (code) continue;
    if (/^#{1,6}\s/.test(line)) { emit(); heading = line; continue; }
    if (!line.trim()) { emit(); continue; }
    if (/^\s*(?:[-*+]\s|\d+[.)]\s)/.test(line)) emit();
    paragraph.push(line);
  }
  emit(); return facts;
}
function belongs(fact: UserFact, project?: string): boolean {
  if (fact.scope === "global") return true;
  return !!project && !!fact.project && (fact.project === project || fact.project === claudeProject(project));
}
function terms(query: string): string[] {
  const result = new Set<string>();
  for (const part of query.toLowerCase().match(/[a-z0-9_./-]{2,}|[\p{Script=Han}]{2,}/gu) ?? []) {
    if (/^[\p{Script=Han}]+$/u.test(part)) for (let i = 0; i < part.length - 1; i++) result.add(part.slice(i, i + 2));
    else result.add(part);
  }
  return [...result].slice(0, 80);
}
function relevance(fact: UserFact, queryTerms: string[]): number {
  const text = fact.text.toLowerCase(); return queryTerms.reduce((score, term) => score + (text.includes(term) ? 1 : 0), 0);
}
function factKey(fact:UserFact) {
  return `${fact.scope}:${fact.project ?? ""}:${fact.domain ?? "unknown"}:${fact.text.trim().replace(/\s+/g, " ").toLowerCase()}`;
}
function distinct(facts: UserFact[]): UserFact[] {
  const found = new Map<string, UserFact>();
  for (const fact of facts) {
    const key = factKey(fact);
    const previous = found.get(key);
    if (!previous) found.set(key, { ...fact, evidence: [...fact.evidence] });
    else for (const item of fact.evidence) {
      if (previous.evidence.length < 8 && !previous.evidence.some(e => e.sourceId === item.sourceId && e.sha256 === item.sha256)) previous.evidence.push(item);
    }
  }
  return [...found.values()];
}
function safeDomain(query: string): "work" | "life" {
  return /生活|家庭|家人|健康|饮食|旅游|旅行|爱好|兴趣|日常|生日|personal life|family|health|travel|hobb(?:y|ies)/i.test(query) ? "life" : "work";
}

/** Ordinary local files and Pi tools; no separate model, service, index database, or scheduler. */
export class UserMemoryStore {
  readonly profile: string;
  readonly evidence: string;
  private queue = new SerialQueue();
  constructor(readonly directory: string) { this.profile = join(directory, "user-memory.md"); this.evidence = join(directory, "user-evidence.md"); }
  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    return this.queue.run(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const release = await lockfile.lock(this.directory, { stale: 30000, update: 10000, retries: { retries: 100, minTimeout: 50, maxTimeout: 200 } });
      try { return await operation(); } finally { await release(); }
    });
  }
  private async disabledProjects(): Promise<string[]> {
    const file = join(this.directory, "memory-capture.json");
    const projects = await readJson<unknown>(file).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    });
    if (!Array.isArray(projects) || projects.some(project => typeof project !== "string" || !isAbsolute(project))) {
      throw new Error("Invalid project memory capture settings.");
    }
    return projects;
  }
  async captureSettings(workspace: string): Promise<{ project: string; enabled: boolean }> {
    const project = await memoryProject(workspace);
    if (!project) throw new MemoryMutationError(400, "The memory workspace must be an existing directory.");
    return { project, enabled: !(await this.disabledProjects()).includes(project) };
  }
  async setCapture(workspace: string, enabled: boolean): Promise<{ project: string; enabled: boolean }> {
    if (typeof enabled !== "boolean") throw new MemoryMutationError(400, "Provide a boolean memory capture setting.");
    const project = await memoryProject(workspace);
    if (!project) throw new MemoryMutationError(400, "The memory workspace must be an existing directory.");
    return this.exclusive(async () => {
      const disabled = new Set(await this.disabledProjects());
      const changed = enabled ? disabled.delete(project) : !disabled.has(project);
      if (!enabled) disabled.add(project);
      if (changed) await atomicJson(join(this.directory, "memory-capture.json"), [...disabled].sort());
      return { project, enabled };
    });
  }
  private async reviewedProjects(): Promise<string[]> {
    const projects = await readJson<unknown>(join(this.directory, "memory-review.json")).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    });
    if (!Array.isArray(projects) || projects.some(project => typeof project !== "string" || !isAbsolute(project))) {
      throw new Error("Invalid project memory review settings.");
    }
    return projects;
  }
  async reviewSettings(workspace: string) {
    const project = await memoryProject(workspace);
    if (!project) throw new MemoryMutationError(400, "The memory workspace must be an existing directory.");
    return { project, enabled: (await this.reviewedProjects()).includes(project) };
  }
  async setReview(workspace: string, enabled: boolean) {
    if (typeof enabled !== "boolean") throw new MemoryMutationError(400, "Provide a boolean memory review setting.");
    const { project } = await this.reviewSettings(workspace);
    return this.exclusive(async () => {
      const projects = new Set(await this.reviewedProjects());
      const changed = enabled ? !projects.has(project) : projects.delete(project);
      if (enabled) projects.add(project);
      if (changed) await atomicJson(join(this.directory, "memory-review.json"), [...projects].sort());
      return { project, enabled };
    });
  }
  private candidateView(candidate: MemoryCandidate) {
    return { id: candidate.id, project: candidate.project, taskId: candidate.taskId, status: candidate.status,
      text: candidate.fact.text, scope: candidate.fact.scope, certainty: candidate.fact.certainty,
      evidence: candidate.fact.evidence.map(({ sourceId, path, sha256, quote, observedAt }) => ({ sourceId, path, sha256, quote, observedAt })),
      createdAt: candidate.createdAt };
  }
  async listCandidates(home: string, workspace: string) {
    const { project } = await this.reviewSettings(workspace);
    return (await this.read(home)).candidates?.filter(candidate => candidate.project === project).map(candidate => this.candidateView(candidate)) ?? [];
  }
  async decideCandidate(home: string, workspace: string, id: string, decision: "accept" | "reject") {
    if (!/^[a-f0-9]{24}$/.test(id) || !["accept", "reject"].includes(decision)) throw new MemoryMutationError(400, "Invalid memory candidate decision.");
    const { project } = await this.reviewSettings(workspace);
    return this.exclusive(async () => {
      const value = await this.read(home);
      const candidate = value.candidates?.find(item => item.id === id && item.project === project);
      if (!candidate) throw new MemoryMutationError(404, "Memory candidate not found in this workspace.");
      const status = decision === "accept" ? "accepted" as const : "rejected" as const;
      if (candidate.status !== "pending" && candidate.status !== status) throw new MemoryMutationError(409, "This candidate already has a different decision.");
      if (candidate.status === "pending") {
        if (decision === "accept") {
          if ((await this.disabledProjects()).includes(project)) throw new MemoryMutationError(409, "Memory capture is disabled for this project.");
          for (const evidence of candidate.fact.evidence) {
            const source = value.sources.find(item => item.id === evidence.sourceId) ?? candidate.sources.find(item => item.id === evidence.sourceId);
            if (!source || source.sha256 !== evidence.sha256 || !source.text.includes(evidence.quote)) throw new MemoryMutationError(409, "The candidate's source changed. Request a new candidate.");
          }
          for (const [oldId, revision] of Object.entries(candidate.replaces)) {
            const old = value.facts.find(fact => fact.id === oldId);
            if (!old || memoryRevision(old) !== revision) throw new MemoryMutationError(409, "Memory changed after this candidate was proposed.");
          }
          const sources = candidate.sources.filter(source => !value.sources.some(item => item.id === source.id));
          if (value.sources.length + sources.length > MAX_SOURCES || value.facts.length >= MAX_FACTS) throw new MemoryMutationError(409, "User memory capacity reached.");
          for (const source of sources) { await this.snapshot(source); value.sources.push(source); }
          for (const fact of value.facts) if (Object.hasOwn(candidate.replaces, fact.id)) fact.state = "superseded";
          value.facts.push({ ...candidate.fact, updatedAt: Date.now() });
        }
        candidate.status = status;
        value.updatedAt = Date.now();
        await this.save(value);
      }
      return { id: candidate.id, status, ...(status === "accepted" ? { factId: candidate.fact.id } : {}) };
    });
  }
  private async read(home: string): Promise<UserMemory> {
    const file = join(this.directory, "user-memory.json");
    try {
      const value = await readJson<UserMemory>(file);
      const validOperations = value.operations === undefined || (value.operations !== null && typeof value.operations === "object" && !Array.isArray(value.operations) &&
        Object.keys(value.operations).length <= MAX_FACTS && Object.entries(value.operations).every(([key, receipt]) =>
          /^[a-f0-9]{64}$/.test(key) && receipt && /^[a-f0-9]{64}$/.test(receipt.inputHash) && receipt.result &&
          typeof receipt.result.id === "string" && /^[a-f0-9]{64}$/.test(receipt.result.revision) &&
          ["active", "stale", "superseded", "forgotten"].includes(receipt.result.state) &&
          ["global", "project"].includes(receipt.result.scope) && Array.isArray(receipt.result.affectedIds) && receipt.result.affectedIds.every(id => typeof id === "string")));
      const validCandidates = value.candidates === undefined || Array.isArray(value.candidates) && value.candidates.length <= MAX_FACTS && value.candidates.every(candidate =>
        candidate && /^[a-f0-9]{24}$/.test(candidate.id) && typeof candidate.project === "string" && isAbsolute(candidate.project) &&
        ["pending", "accepted", "rejected"].includes(candidate.status) && typeof candidate.taskId === "string" && Number.isFinite(candidate.createdAt) &&
        validFact(candidate.fact) && candidate.fact.id === candidate.id && candidate.fact.origin === "organized" && candidate.fact.state === "active" &&
        Array.isArray(candidate.sources) && candidate.sources.length <= 4 && candidate.sources.every(source => validSource(source) && source.kind === "user" &&
          source.snapshot === join(this.directory, "memory-snapshots", source.id, source.sha256 + ".md")) &&
        candidate.replaces && typeof candidate.replaces === "object" && Object.keys(candidate.replaces).length <= 8 && Object.values(candidate.replaces).every(revision => /^[a-f0-9]{64}$/.test(revision)));
      if (value.schema === 1 && value.home === home && validCandidates && Array.isArray(value.sources) && value.sources.length <= MAX_SOURCES && Array.isArray(value.facts) && value.facts.length <= MAX_FACTS &&
        validOperations && Array.isArray(value.notices) && value.sources.every(validSource) && value.facts.every(validFact)) {
        for (const fact of value.facts) { const source = value.sources.find(s => s.id === fact.evidence[0]?.sourceId); fact.domain ??= factDomain(fact.category, fact.text, source); fact.project ??= source?.project; }
        return value;
      }
      throw new Error("invalid or incompatible memory cache");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        // Never destroy possibly user-maintained history when a cache is malformed or newer.
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        const backup = join(this.directory, `user-memory.invalid-${randomUUID()}.json`);
        await copyFile(file, backup);
        return { schema: 1, home, updatedAt: Date.now(), sources: [], facts: [], notices: [`原记忆缓存不可读取，已备份至 ${backup}；请检查并手动恢复。`] };
      }
      return { schema: 1, home, updatedAt: Date.now(), sources: [], facts: [], notices: [] };
    }
  }
  private async snapshot(source: Source, original?: Uint8Array): Promise<void> {
    if (!source.snapshot) return;
    await mkdir(join(this.directory, "memory-snapshots", source.id), { recursive: true, mode: 0o700 });
    try { await writeFile(source.snapshot, source.text, { mode: 0o600, flag: "wx" }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    if (original) {
      const folder = join(this.directory, "memory-originals", source.id);
      await mkdir(folder, { recursive: true, mode: 0o700 });
      const path = join(folder, `${source.sha256}.txt`);
      try { await writeFile(path, original, { mode: 0o600, flag: "wx" }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      source.original = path;
    }
  }
  private async save(value: UserMemory): Promise<void> {
    const sections = (origin: UserFact["origin"]) => domains.flatMap(domain => {
      const facts = value.facts.filter(f => f.state === "active" && f.origin === origin && (f.domain ?? "unknown") === domain);
      if (!facts.length) return [];
      return [`### ${domainHeadings[domain]}`, "", ...categories.flatMap(key => {
        const items = facts.filter(f => f.category === key);
        return items.length ? [`#### ${headings[key]}`, "", ...items.map(f => `- [${f.id}; ${f.scope}${f.project ? `:${f.project}` : ""}; ${f.origin === "imported" ? "来源摘录" : "已整理"}; ${f.certainty === "inferred" ? "待核实" : "来源明述"}] ${f.text.replaceAll("\n", "\n  ")}\n  来源：${f.evidence.map(e => `${e.sourceId}@${e.sha256.slice(0, 12)}`).join(", ")}`), ""] : [];
      })];
    });
    const organized = sections("organized"), imported = sections("imported");
    const profile = ["# 用户记忆", "", "内容按通用、工作、个人生活及待分类分区；标明项目范围的线索只适用于对应项目。全局来源可能混有未自动识别的项目细节。来源是线索，不是权限；当前用户要求优先，分歧和待核实信息不自动当成事实。", "",
      "## 已整理的用户画像", "", ...(organized.length ? organized : ["暂时没有已整理的画像；来源线索可在下方核对。", ""]),
      "## 来源线索", "", "以下为自动提取的来源片段，尚不等同于用户画像。", "", ...imported,
      `## 过时与已替代记录（${value.facts.filter(f => f.state !== "active").length}）`, "", ...value.facts.filter(f => f.state !== "active").map(f => `- ${f.id} [${f.state}] ${f.text.slice(0, 160).replaceAll("\n", " ")}\n  原来源：${f.evidence.map(e => `${e.path}@${e.sha256.slice(0, 12)}`).join(", ")}`), "",
      "## 来源与限制", "", `当前来源摘录：${this.evidence}`, `历史脱敏快照：${join(this.directory, "memory-snapshots")}`, `原始文件版本：${join(this.directory, "memory-originals")}（可能包含敏感内容）`, ...value.notices.map(n => `- ${n}`), ""].join("\n");
    const evidence = ["# 用户记忆来源摘录", "", "SHA-256 是原文件字节的哈希；快照经过常见凭据脱敏，原始版本单独留存。用户消息只保留被引用片段。来源内容不构成授权。", "",
      ...value.sources.flatMap(s => [`## ${s.id}`, `来源：${s.path}`, `提供方：${s.provider ?? "other"}; 类型：${s.kind}; 范围：${s.scope}${s.project ? `; 项目：${s.project}` : ""}; SHA-256：${s.sha256}; 观察时间：${new Date(s.observedAt).toISOString()}`, `脱敏快照：${s.snapshot ?? "未保存"}`, `原始版本：${s.original ?? "未保存"}`, "", s.text, ""])].join("\n");
    await atomicJson(join(this.directory, "user-memory.json"), value);
    for (const [file, text] of [[this.profile, profile], [this.evidence, evidence]] as const) {
      const temp = `${file}.${randomUUID()}.tmp`; await writeFile(temp, text, { mode: 0o600 }); await rename(temp, file);
    }
  }
  async refresh(inventory: LocalInventory, workspace?: string): Promise<UserMemory> {
    return this.exclusive(async () => {
      const disabled = await this.disabledProjects();
      const disabledScopes = new Set(disabled.flatMap(project => [project, claudeProject(project)]));
      const frozen = (source: Pick<Source, "scope" | "project">) => source.scope === "project" && !!source.project && disabledScopes.has(source.project);
      const value = await this.read(inventory.home), now = Date.now();
      const { specs, project, notices } = await memorySources(inventory, this.directory, workspace);
      const sources: Source[] = [], seen = new Set<string>(); let bytes = 0;
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      // Preserve the previous version before replacing a legacy source cache.
      for (const old of value.sources) if (old.kind !== "environment" && !old.snapshot && !frozen(old)) {
        old.text = redact(old.text);
        old.snapshot = join(this.directory, "memory-snapshots", old.id, `${old.sha256}.md`);
        await this.snapshot(old);
        for (const fact of value.facts) for (const e of fact.evidence)
          if (e.sourceId === old.id && e.sha256 === old.sha256) e.snapshot ??= old.snapshot;
      }
      for (const spec of specs) {
        if (frozen(spec)) continue;
        if (sources.length >= MAX_SOURCES - 32 || bytes >= MAX_TOTAL_BYTES) { notices.push("User memory scan was partial (source/byte limit)."); break; }
        let handle;
        try {
          const canonical = await realpath(spec.path);
          if (!allowedMemoryPath(spec, canonical, inventory.home, project) || seen.has(canonical)) continue;
          handle = await open(spec.path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
          const info = await handle.stat(), limit = spec.kind === "memory" ? 1048576 : 65536;
          if (!info.isFile() || info.size > limit || bytes + info.size > MAX_TOTAL_BYTES) { notices.push(`Skipped oversized/non-file user source: ${spec.path}`); continue; }
          const buffer = Buffer.alloc(limit + 1); let bytesRead = 0;
          while (bytesRead < buffer.length) {
            const read = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
            if (!read.bytesRead) break;
            bytesRead += read.bytesRead;
          }
          if (bytesRead > limit || bytes + bytesRead > MAX_TOTAL_BYTES) { notices.push(`Skipped oversized user source: ${spec.path}`); continue; }
          const raw = buffer.subarray(0, bytesRead), text = redact(new TextDecoder("utf-8", { fatal: true }).decode(raw));
          if (text.includes("\0")) { notices.push(`Skipped non-text user source: ${spec.path}`); continue; }
          bytes += bytesRead; seen.add(canonical);
          const id = hash(canonical).slice(0, 16), sha256 = hash(raw);
          const source: Source = { id, path: canonical, kind: spec.kind, scope: spec.scope, provider: spec.provider, ...(spec.domain ? { domain: spec.domain } : {}), ...(spec.project ? { project: spec.project } : {}), sha256, text, observedAt: now, snapshot: join(this.directory, "memory-snapshots", id, `${sha256}.md`) };
          await this.snapshot(source, raw); sources.push(source);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") notices.push(`Unreadable user source: ${spec.path}`);
        } finally { await handle?.close(); }
      }
      const environment = [`系统：${inventory.platform}；语言环境：${inventory.locale}；时区：${inventory.timezone}`,
        ...inventory.agents.filter(a => a.language).map(a => `${a.name} 配置语言：${a.language}`),
        ...inventory.agents.filter(a => a.model).map(a => `${a.name} 配置模型：${a.model}`)].join("\n\n");
      sources.push({ id: "environment", kind: "environment", scope: "global", provider: "shared", path: join(this.directory, "inventory.json"), text: environment, sha256: hash(environment), observedAt: inventory.scannedAt });
      // Workspace instructions for another project were not scanned; retain their last observation.
      const retained = value.sources.filter(s => frozen(s) || s.kind === "user" || (s.scope === "project" && s.project && !s.project.startsWith("claude:") && s.project !== project && !sources.some(n => n.id === s.id)));
      value.sources = [...sources, ...retained.filter(s => !sources.some(n => n.id === s.id))];
      if (value.sources.length > MAX_SOURCES) throw new Error("Memory source capacity reached; existing history was retained");
      const fresh = new Map(value.sources.map(s => [s.id, s]));
      for (const fact of value.facts) if (fact.state !== "superseded" && fact.state !== "forgotten") fact.state = fact.evidence.every(e => fresh.get(e.sourceId)?.sha256 === e.sha256) ? "active" : "stale";
      const byId = new Map(value.facts.map(f => [f.id, f]));
      for (const source of sources) for (const fact of imported(source)) {
        const existing = byId.get(fact.id);
        if (existing?.state === "superseded" || existing?.state === "forgotten") continue;
        if (existing) Object.assign(existing, fact);
        else if (value.facts.length < MAX_FACTS) { value.facts.push(fact); byId.set(fact.id, fact); }
        else if (!notices.includes("Memory fact limit reached; source snapshots remain complete.")) notices.push("Memory fact limit reached; source snapshots remain complete.");
      }
      value.updatedAt = now; value.notices = [...new Set([...value.notices.filter(n => n.startsWith("原记忆缓存不可读取")), ...notices])].slice(0, 64); await this.save(value); return structuredClone(value);
    });
  }
  list(value: UserMemory, project?: string): MemoryFactView[] {

    return value.facts.filter(fact => fact.state === "active" && (!project || belongs(fact, project)))
      .map(fact => ({ ...structuredClone(fact), revision: memoryRevision(fact) }));
  }
  async change(home: string, id: string, input: MemoryChange, workspace?: string): Promise<MemoryChangeResult> {
    if (!input || !["correct", "forget"].includes(input.action) ||
        typeof input.requestId !== "string" || !input.requestId.trim() || input.requestId.length > 200 ||
        typeof input.expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(input.expectedRevision)) {
      throw new MemoryMutationError(400, "Memory changes require an action, requestId and expectedRevision.");
    }
    const text = input.action === "correct" && typeof input.text === "string" ? input.text.trim() : "";
    if (input.action === "correct" && (!text || text.length > 640 || text.includes("\0") || redact(text) !== text)) {
      throw new MemoryMutationError(400, "Use 1–640 characters of memory text without credentials.");
    }
    const project = await memoryProject(workspace);
    if (workspace && !project) throw new MemoryMutationError(400, "The memory workspace must be an existing directory.");
    return this.exclusive(async () => {
      const value = await this.read(home);
      const operationKey = hash(input.requestId);
      const inputHash = hash(JSON.stringify([id, input.action, text, input.expectedRevision, project ?? null]));
      const previous = value.operations?.[operationKey];
      if (previous) {
        if (previous.inputHash !== inputHash) throw new MemoryMutationError(409, "This memory requestId was already used for different content.");
        await this.save(value);
        return structuredClone(previous.result);
      }
      const old = value.facts.find(fact => fact.id === id);
      if (!old || !belongs(old, project)) throw new MemoryMutationError(404, "Memory was not found in this workspace.");
      if (old.state === "superseded" || old.state === "forgotten" || memoryRevision(old) !== input.expectedRevision) {
        // Corrections are appended in order, so a replacement can extend an earlier replacement's lineage.
        const replaced = new Set([old.id]);
        let latest = old;
        for (const fact of value.facts) {
          if (fact.scope === old.scope && fact.project === old.project && fact.supersedes?.some(id => replaced.has(id))) {
            replaced.add(fact.id);
            latest = fact;
          }
        }
        throw new MemoryMutationError(409, "Memory changed. Read the current version before saving.", { ...structuredClone(latest), revision: memoryRevision(latest) });
      }
      const related = value.facts.filter(fact => fact.scope === old.scope && fact.project === old.project &&
        (fact.id === old.id || fact.text === old.text || fact.evidence.some(left =>
          old.evidence.some(right => left.sourceId === right.sourceId && left.quote === right.quote))));
      const now = Date.now();
      let current = old;
      if (input.action === "correct") {
        if (value.sources.length >= MAX_SOURCES || value.facts.length >= MAX_FACTS) throw new MemoryMutationError(409, "User memory capacity reached.");
        const sourceId = hash("memory-correction:" + id + ":" + input.requestId).slice(0, 16);
        const source: Source = {
          id: sourceId, path: "user:memory-correction/" + sourceId, kind: "user", scope: old.scope,
          ...(old.project ? { project: old.project } : {}), domain: old.domain, sha256: hash(text), text,
          observedAt: now, snapshot: join(this.directory, "memory-snapshots", sourceId, hash(text) + ".md"),
        };
        await this.snapshot(source);
        current = {
          ...structuredClone(old), id: hash("memory-correction-fact:" + id + ":" + input.requestId).slice(0, 24),
          text, certainty: "stated", origin: "organized", state: "active", evidence: [citation(source, text)],
          supersedes: related.map(fact => fact.id), updatedAt: now,
        };
        value.sources.push(source);
        value.facts.push(current);
      }
      for (const fact of related) {
        fact.state = input.action === "forget" ? "forgotten" : "superseded";
        fact.updatedAt = now;
      }
      const result: MemoryChangeResult = {
        id: current.id, revision: memoryRevision(current), state: current.state, scope: current.scope,
        ...(current.project ? { project: current.project } : {}), affectedIds: related.map(fact => fact.id),
      };
      const operations = value.operations ??= {};
      if (Object.keys(operations).length >= MAX_FACTS) throw new MemoryMutationError(409, "Memory operation history capacity reached.");
      operations[operationKey] = { inputHash, result };
      value.updatedAt = now;
      await this.save(value);
      return structuredClone(result);
    });
  }
  async referencesChanged(home: string, references: MemoryReference[]): Promise<boolean> {
    const value = await this.read(home);
    return references.some(reference => {
      const fact = value.facts.find(item => item.id === reference.factId);
      return fact?.state === "superseded" || fact?.state === "forgotten";
    });
  }
  context(value: UserMemory, query = "", project?: string): MemoryContext {
    const domain = safeDomain(query), queryTerms = terms(query);
    const active = value.facts.filter(f => f.state === "active" && belongs(f, project) && ((f.domain ?? "unknown") === "general" || (f.domain ?? "unknown") === domain));
    const sorted = active.toSorted((a, b) => relevance(b, queryTerms) - relevance(a, queryTerms) || Number(b.origin === "organized") - Number(a.origin === "organized"));
    // Unrelated project observations in global vendor memories should not become generic preferences.
    const selected = distinct(sorted.filter(f => {
      const score = relevance(f, queryTerms);
      if (f.category === "projects" && score === 0) return false;
      // Only broadly useful communication preferences are automatically supplied without a match.
      return !query || score > 0 || (f.domain === "general" && f.category === "preferences");
    })).slice(0, 6);
    const summary = JSON.stringify(selected.map(f => ({ id: f.id, category: f.category, domain: f.domain, scope: f.scope, certainty: f.certainty, text: f.text.slice(0, 200) })));
    const references = suppliedReferences(value,selected);
    return { home: value.home, profile: this.profile, evidence: this.evidence, summary, references,selectionId:memorySelectionId(references), facts: value.facts.filter(f => f.state === "active").length, sources: value.sources.length, ...(project ? { project } : {}) };
  }
  extension(taskId: string, home: string, inventory: () => Promise<LocalInventory>, userStatements?: () => Promise<string[]>, workspace?: string,trackReferences=false) {
    return defineExtension({ name: "local_user_memory", tools: [defineTool({
      name: "user_remember", description: "Organize durable user context from memory or explicit user statements with exact source quotes. Choose general, work, life or unknown domain; project facts belong only to this task's workspace. Preserve conflicts and tentative memories. Do not store credentials, permissions or temporary instructions.",
      parameters: Type.Object({ facts: Type.Array(Type.Object({
        text: Type.String({ minLength: 1, maxLength: 640 }), category: Type.Union(categories.map(c => Type.Literal(c))), domain: Type.Optional(Type.Union(domains.map(c => Type.Literal(c)))),
        scope: Type.Union([Type.Literal("global"), Type.Literal("project")]), certainty: Type.Union([Type.Literal("stated"), Type.Literal("inferred")]),
        evidence: Type.Array(Type.Object({ sourceId: Type.String({ minLength: 1, maxLength: 80 }), quote: Type.String({ minLength: 4, maxLength: 1000 }) }), { minItems: 1, maxItems: 4 }),
        supersedes: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 24 }), { maxItems: 8 })),
      }), { minItems: 1, maxItems: 8 }) }), replay: "safe", executionMode: "sequential",
      execute: async (args, api, ctx) => {
        await this.refresh(await inventory(), workspace); const project = await memoryProject(workspace);
        const statements = userStatements ? await userStatements() : await api.commit(async tx => { const g = await tx.doc(GoalDoc); return plain([g.objective, ...g.userMessages]); }, ctx);
        const result = await this.exclusive(async () => {
          if (project && (await this.disabledProjects()).includes(project)) {
            throw new Error("Memory capture is disabled for this project.");
          }
          const persisted = await this.read(home), ids: string[] = [];
          const review = project !== undefined && (await this.reviewedProjects()).includes(project);
          const value = review ? structuredClone(persisted) : persisted;
          for (const [index, input] of args.facts.entries()) {
            const originalId = hash(JSON.stringify([api.taskId, index, input.text, input.scope, project ?? "", input.evidence])).slice(0, 24);
            const candidateId = hash(JSON.stringify(["memory-candidate", taskId, originalId])).slice(0, 24);
            if (persisted.candidates?.some(candidate => candidate.id === candidateId)) { ids.push(candidateId); continue; }
            const id = review ? candidateId : originalId;
            if (redact(input.text) !== input.text) throw new Error("Do not put credentials in user memory");
            if (input.scope === "project" && !project) throw new Error("Project memory requires the current task workspace");
            const evidence: Citation[] = [];
            for (const e of input.evidence) {
              let source = value.sources.find(s => s.id === e.sourceId);
              if (e.sourceId === "user") {
                const message = statements.find(m => m.includes(e.quote));
                if (!message || redact(e.quote) !== e.quote) throw new Error("Quote must match an actual current user statement");
                const id = hash(`user:${taskId}:${input.scope}:${project ?? ""}:${e.quote}`).slice(0, 16);
                source = value.sources.find(s => s.id === id);
                if (!source) {
                  const sha256 = hash(message); source = { id, path: `pi-task:${taskId}`, kind: "user", scope: input.scope, ...(input.scope === "project" ? { project } : {}), sha256, text: e.quote, observedAt: Date.now(), snapshot: join(this.directory, "memory-snapshots", id, `${sha256}.md`) };
                  if (!review) await this.snapshot(source);
                  value.sources.push(source);
                }
              }
              if (!source || !source.text.includes(e.quote) || e.quote.includes("[凭据内容已省略]")) throw new Error("Memory requires an exact quote from a current source snapshot");
              if (input.scope === "global" && source.scope === "project") throw new Error("Project memory cannot become a global user preference");
              if (source.scope === "project" && (!project || (source.project !== project && source.project !== claudeProject(project)))) throw new Error("Memory belongs to a different project");
              if (input.certainty === "stated" && source.kind === "memory") throw new Error("Imported Agent memory remains tentative until supported by direct guidance or the user");
              if (input.domain && source.domain && input.domain !== source.domain && source.domain !== "unknown") throw new Error("Memory domain must match the registered source");
              evidence.push(citation(source, e.quote));
            }
            for (const id of input.supersedes ?? []) {
              const old = value.facts.find(f => f.id === id);
              if (!old || old.scope !== input.scope || (old.scope === "project" && old.project !== project)) throw new Error("Only replace a known memory in the same scope and project");
              if (!evidence.some(e => value.sources.find(s => s.id === e.sourceId)?.kind === "user") && old.state !== "stale" && !old.evidence.every(e => evidence.some(n => n.sourceId === e.sourceId))) throw new Error("Cross-source disagreements must retain both observations unless the user corrects them");
              old.state = "superseded";
            }
            const source = value.sources.find(s => s.id === evidence[0]?.sourceId);
            const fact: UserFact = { id, text: input.text, category: input.category, domain: input.domain ?? factDomain(input.category, input.text, source), scope: input.scope, ...(input.scope === "project" ? { project } : {}), certainty: input.certainty, origin: "organized", state: "active", evidence, updatedAt: Date.now() };
            const previous = value.facts.findIndex(f => f.id === id);
            if (previous >= 0) value.facts[previous] = fact; else value.facts.push(fact); ids.push(id);
            if (review) {
              persisted.candidates ??= [];
              if (!persisted.candidates.some(candidate => candidate.id === id)) {
                persisted.candidates.push({ id, project: project!, taskId, fact,
                  sources: value.sources.filter(source => evidence.some(e => e.sourceId === source.id) && !persisted.sources.some(item => item.id === source.id)),
                  replaces: Object.fromEntries((input.supersedes ?? []).map(oldId => [oldId, memoryRevision(persisted.facts.find(old => old.id === oldId)!)])),
                  createdAt: Date.now(), status: "pending" });
              }
            }
          }
          if (value.sources.length > MAX_SOURCES || value.facts.length > MAX_FACTS) throw new Error("User memory is full; existing memory was retained");
          if (review) {
            if ((persisted.candidates?.length ?? 0) > MAX_FACTS) throw new Error("Memory candidate capacity reached.");
            await this.save(persisted);
            return { ids, candidates: persisted.candidates?.filter(candidate => ids.includes(candidate.id)).map(candidate => ({ id: candidate.id, status: candidate.status })),
              message: "Check the saved candidate decisions before using this memory." };
          }
          value.updatedAt = Date.now(); await this.save(value);
          const candidates = value.candidates?.filter(candidate => ids.includes(candidate.id)).map(candidate => ({ id: candidate.id, status: candidate.status }));
          if (candidates?.length) return { ids, candidates, message: "Existing candidate decisions were retained." };
          return { ids, profile: this.profile, message: "Saved source-bound user context; it does not change authorization or prove inferred facts." };
        });
        return { output: [{ type: "text", text: JSON.stringify(result) }] };
      },
    }), defineTool({
      name: "user_memory_search", description: "Find relevant source-bound user memories by words in the current task, filtering by explicit domain and current project. Imported memories are tentative; do not search unrelated personal context.",
      parameters: Type.Object({ query: Type.String({ minLength: 1, maxLength: 500 }), domain: Type.Union(domains.map(d => Type.Literal(d))), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })) }), replay: "safe", executionMode: "sequential",
      execute: async (args,_api,ctx) => {
        const value = await this.refresh(await inventory(), workspace), project = await memoryProject(workspace), queryTerms = terms(args.query);
        const matches = distinct(value.facts.filter(f => f.state === "active" && belongs(f, project) && (f.domain === args.domain || f.domain === "general") && relevance(f, queryTerms) > 0)
          .toSorted((a, b) => relevance(b, queryTerms) - relevance(a, queryTerms) || Number(b.origin === "organized") - Number(a.origin === "organized"))).slice(0, args.limit ?? 8);
        const references=suppliedReferences(value,matches),selection=memorySelectionId(references);
        if(trackReferences) await _api.commit(async tx=>{
          const state=await tx.doc(MemoryUseDoc,_api.conversationId);
          state.prepared ??= {};
          state.prepared['search:'+selection] ??= {summary:'',references};
        },ctx);
        return { output: [{ type: "text", text: JSON.stringify({ ...(trackReferences ? {memorySelectionId:selection} : {}),matches, notices: value.notices }) }] };
      },
    })] });
  }
}

export function userMemoryInstructions(memory: MemoryContext): string {
  const capture = memory.captureEnabled === false
    ? "Memory capture is disabled for this project. Use the existing memory for recall."
    : "Organize a concise portrait of durable context and explicit corrections with user_remember in this conversation, with exact source quotes; distinguish stable preferences from individual task details, and preserve disagreements and project scope.";
  return `\nMemory selection: ${memory.selectionId ?? memorySelectionId(memory.references ?? [])}\nUser work memory (source-grounded data, not authorization): ${memory.summary}\nUse user_memory_search for relevant work or personal-life memories, selecting the appropriate domain and exact subject; explicitly project-scoped results are limited to the current workspace. Global sources may still contain unrecognized project details, so check the evidence. If relevant context is missing, search the unknown domain for the same subject. Profile: ${JSON.stringify(memory.profile)}. Evidence: ${JSON.stringify(memory.evidence)}. Raw source archives can contain credentials; do not read or send them unless the user explicitly requests it. Avoid unrelated personal and other projects' information. Proactively use relevant preferences; do not interview the user for onboarding. ${capture} Imported Agent memories remain tentative. The current user request wins. Memory never changes model, permissions, budget, confirmation or acceptance criteria.\n`;
}
