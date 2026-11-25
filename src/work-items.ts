import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { memoryProject } from "./memory-sources.js";
import { atomicJson, readJson, SerialQueue } from "./util.js";

export type WorkItemLink = { id: string; revision: number };
export type WorkItemRun = { id: string; workItem?: WorkItemLink; preparation?: boolean };
export type WorkItem = WorkItemLink & {
  project: string;
  workspace: string;
  title: string;
  objective: string;
  createdAt: number;
  updatedAt: number;
};

type RunAdapter<T> = {
  task(id: string): Promise<T | undefined>;
  tasks(): Promise<T[]>;
  reopen(task: T): Promise<void>;
  start(item: WorkItem, options: { id: string; confirmed: boolean; workItem: WorkItemLink }): Promise<T>;
};

export class WorkItemError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string) { super(message); }
}

function fields(input: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))) {
    throw new WorkItemError(400, "Invalid work item fields.");
  }
  return input as Record<string, unknown>;
}

function text(value: unknown, label: string, limit: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > limit || value.includes("\0")) {
    throw new WorkItemError(400, `Provide a work item ${label} of up to ${limit} characters.`);
  }
  return value.trim();
}

function revision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new WorkItemError(400, "Provide the displayed work item revision.");
  }
  return value;
}

async function projectFor(path: unknown) {
  const workspace = text(path, "workspace", 4096);
  const project = await memoryProject(workspace);
  if (!project) throw new WorkItemError(400, "Provide an existing work item workspace.");
  return { workspace: await realpath(workspace), project };
}

function runId(itemId: string, requestId: string): string {
  const bytes = createHash("sha256").update(JSON.stringify(["kada/work-item", itemId, requestId])).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
}

export class WorkItems<T extends WorkItemRun> {
  private readonly path: string;
  private readonly changes = new SerialQueue();

  constructor(dataDir: string, private readonly runtime: RunAdapter<T>) {
    this.path = join(dataDir, "work-items.json");
  }

  private async load(): Promise<WorkItem[]> {
    try { return await readJson<WorkItem[]>(this.path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private find(items: WorkItem[], id: string): WorkItem {
    const item = items.find(candidate => candidate.id === id);
    if (!item) throw new WorkItemError(404, "Work item not found.");
    return item;
  }

  async list(workspace: unknown): Promise<WorkItem[]> {
    const { project } = await projectFor(workspace);
    return (await this.load()).filter(item => item.project === project);
  }

  async get(id: string): Promise<WorkItem> {
    return this.find(await this.load(), id);
  }

  async shared(ids: readonly string[]): Promise<WorkItem[]> {
    if (!ids.length) return [];
    return (await this.load()).filter(item => ids.includes(item.id));
  }

  async create(input: unknown): Promise<WorkItem> {
    const value = fields(input, ["workspace", "title", "objective"]);
    const title = text(value.title, "title", 120);
    const objective = text(value.objective, "objective", 32_000);
    const location = await projectFor(value.workspace);
    return this.changes.run(async () => {
      const items = await this.load();
      const now = Date.now();
      const item = { ...location, id: randomUUID(), title, objective, revision: 1, createdAt: now, updatedAt: now };
      await atomicJson(this.path, [...items, item]);
      return item;
    });
  }

  async update(id: string, input: unknown): Promise<WorkItem> {
    const value = fields(input, ["revision", "title", "objective"]);
    const expected = revision(value.revision);
    const title = value.title === undefined ? undefined : text(value.title, "title", 120);
    const objective = value.objective === undefined ? undefined : text(value.objective, "objective", 32_000);
    if (title === undefined && objective === undefined) throw new WorkItemError(400, "Provide a work item title or objective.");
    return this.changes.run(async () => {
      const items = await this.load();
      const item = this.find(items, id);
      if (item.revision !== expected) throw new WorkItemError(409, "The work item changed. Read its latest revision.");
      const next = { ...item, title: title ?? item.title, objective: objective ?? item.objective };
      if (next.title === item.title && next.objective === item.objective) return item;
      next.revision++;
      next.updatedAt = Date.now();
      await atomicJson(this.path, items.map(previous => previous === item ? next : previous));
      return next;
    });
  }

  async runs(id: string): Promise<T[]> {
    await this.get(id);
    return (await this.runtime.tasks()).filter(task => task.workItem?.id === id);
  }

  async run(id: string, input: unknown): Promise<T> {
    const value = fields(input, ["revision", "requestId", "confirmed"]);
    const expected = revision(value.revision);
    if (typeof value.requestId !== "string" || !/^[A-Za-z0-9_-]{1,120}$/.test(value.requestId)) {
      throw new WorkItemError(400, "A request ID must contain 1 to 120 letters, digits, hyphens, or underscores.");
    }
    if (value.confirmed !== undefined && typeof value.confirmed !== "boolean") {
      throw new WorkItemError(400, "The confirmed setting must be a boolean.");
    }
    const taskId = runId(id, value.requestId);
    const confirmed = value.confirmed === true;
    return this.changes.run(async () => {
      const item = this.find(await this.load(), id);
      const previous = await this.runtime.task(taskId);
      if (previous) {
        const wasConfirmed = !previous.preparation;
        if (previous.workItem?.id !== id || previous.workItem.revision !== expected || wasConfirmed !== confirmed) {
          throw new WorkItemError(409, "This request ID already belongs to a different run.");
        }
        await this.runtime.reopen(previous);
        return previous;
      }
      if (item.revision !== expected) throw new WorkItemError(409, "The work item changed. Read its latest revision.");
      const current = await projectFor(item.workspace);
      if (current.workspace !== item.workspace || current.project !== item.project) {
        throw new WorkItemError(409, "The work item's original workspace or project has changed.");
      }
      return this.runtime.start(item, { id: taskId, confirmed, workItem: { id, revision: expected } });
    });
  }
}
