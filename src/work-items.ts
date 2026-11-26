import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { memoryProject } from "./memory-sources.js";
import { atomicJson, readJson, SerialQueue } from "./util.js";

export type WorkItemLink = { id: string; revision: number };
export type WorkItemRun = { id: string; workItem?: WorkItemLink; preparation?: boolean };
export type WorkItemStatus = 'open' | 'parked' | 'done';
export type WorkItem = WorkItemLink & {
  project: string;
  workspace: string;
  title: string;
  objective: string;
  status: WorkItemStatus;
  archived: boolean;
  completedAt: number | null;
  createdAt: number;
  updatedAt: number;
};
type StoredWorkItem = Omit<WorkItem, 'status' | 'archived' | 'completedAt'> & Partial<Pick<WorkItem, 'status' | 'archived' | 'completedAt'>> & {
  operations?: { requestId: string; fingerprint: string; result: WorkItem }[];
};
export type WorkItemRequest = { requestId: string; project: string };

function view(item: StoredWorkItem): WorkItem {
  const { id, revision, project, workspace, title, objective, createdAt, updatedAt } = item;
  return { id, revision, project, workspace, title, objective, createdAt, updatedAt,
    status: item.status ?? 'open', archived: item.archived ?? false, completedAt: item.completedAt ?? null };
}

function status(value: unknown): WorkItemStatus {
  if (value !== 'open' && value !== 'parked' && value !== 'done') throw new WorkItemError(400, 'Work item status must be open, parked or done.');
  return value;
}

function requestKey(request?: WorkItemRequest) {
  if (request && (typeof request.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(request.requestId) || typeof request.project !== 'string' || !request.project)) {
    throw new WorkItemError(400, 'Provide a valid work item request ID and original project.');
  }
}

function replay(items: StoredWorkItem[], requestId: string, fingerprint: string): WorkItem | undefined {
  for (const item of items) for (const operation of item.operations ?? []) if (operation.requestId === requestId) {
    if (operation.fingerprint !== fingerprint) throw new WorkItemError(409, 'This work item request already has different content.');
    return operation.result;
  }
}

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

  private async load(): Promise<StoredWorkItem[]> {
    try { return await readJson<StoredWorkItem[]>(this.path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private find(items: StoredWorkItem[], id: string): StoredWorkItem {
    const item = items.find(candidate => candidate.id === id);
    if (!item) throw new WorkItemError(404, "Work item not found.");
    return item;
  }

  async list(workspace: unknown, expectedProject?: string): Promise<WorkItem[]> {
    const { project } = await projectFor(workspace);
    if (expectedProject !== undefined && expectedProject !== project) throw new WorkItemError(409, 'The original work item project changed.');
    return (await this.load()).filter(item => item.project === project).map(view);
  }

  async get(id: string): Promise<WorkItem> {
    return view(this.find(await this.load(), id));
  }

  async shared(ids: readonly string[]): Promise<WorkItem[]> {
    if (!ids.length) return [];
    return (await this.load()).filter(item => ids.includes(item.id)).map(view);
  }

  async create(input: unknown, request?: WorkItemRequest): Promise<WorkItem> {
    requestKey(request);
    const value = fields(input, ["workspace", "title", "objective", "status"]);
    const title = text(value.title, "title", 120);
    const objective = text(value.objective, "objective", 32_000);
    const workspace = text(value.workspace, 'workspace', 4096), state = value.status === undefined ? 'open' : status(value.status);
    const fingerprint = createHash('sha256').update(JSON.stringify(['create', workspace, title, objective, state, request?.project])).digest('hex');
    return this.changes.run(async () => {
      const items = await this.load();
      const receipt = request ? replay(items, request.requestId, fingerprint) : undefined;
      if (receipt) return receipt;
      const location = await projectFor(workspace);
      if (request && location.project !== request.project) throw new WorkItemError(409, 'The original work item project changed.');
      const now = Date.now();
      const item: WorkItem = { ...location, id: randomUUID(), title, objective, status: state, archived: false,
        completedAt: state === 'done' ? now : null, revision: 1, createdAt: now, updatedAt: now };
      await atomicJson(this.path, [...items, { ...item, ...(request ? { operations: [{ requestId: request.requestId, fingerprint, result: item }] } : {}) }]);
      return item;
    });
  }

  async update(id: string, input: unknown, request?: WorkItemRequest): Promise<WorkItem> {
    requestKey(request);
    const value = fields(input, ["revision", "title", "objective", "status", "archived"]);
    const expected = revision(value.revision);
    const title = value.title === undefined ? undefined : text(value.title, "title", 120);
    const objective = value.objective === undefined ? undefined : text(value.objective, "objective", 32_000);
    const state = value.status === undefined ? undefined : status(value.status);
    if (value.archived !== undefined && typeof value.archived !== 'boolean') throw new WorkItemError(400, 'The archived setting must be a boolean.');
    const archived = value.archived as boolean | undefined;
    if (title === undefined && objective === undefined && state === undefined && archived === undefined) throw new WorkItemError(400, "Provide work item fields to update.");
    const fingerprint = createHash('sha256').update(JSON.stringify(['update', id, expected, title, objective, state, archived, request?.project])).digest('hex');
    return this.changes.run(async () => {
      const items = await this.load();
      const receipt = request ? replay(items, request.requestId, fingerprint) : undefined;
      if (receipt) return receipt;
      const item = this.find(items, id);
      if (request && item.project !== request.project) throw new WorkItemError(404, 'Work item not found in this project.');
      if (item.revision !== expected) throw new WorkItemError(409, "The work item changed. Read its latest revision.");
      const previous = view(item), next = { ...previous, title: title ?? previous.title, objective: objective ?? previous.objective,
        status: state ?? previous.status, archived: archived ?? previous.archived };
      const changed = next.title !== previous.title || next.objective !== previous.objective || next.status !== previous.status || next.archived !== previous.archived;
      if (!changed && !request) return previous;
      if (changed) {
        next.revision++; next.updatedAt = Date.now();
        if (next.status !== previous.status) next.completedAt = next.status === 'done' ? next.updatedAt : null;
      }
      const stored = { ...next, operations: request ? [...(item.operations ?? []), { requestId: request.requestId, fingerprint, result: next }] : item.operations };
      await atomicJson(this.path, items.map(previous => previous === item ? stored : previous));
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
      if (item.archived || item.status === 'done') throw new WorkItemError(409, 'Reopen and unarchive the work item before starting another run.');
      const current = await projectFor(item.workspace);
      if (current.workspace !== item.workspace || current.project !== item.project) {
        throw new WorkItemError(409, "The work item's original workspace or project has changed.");
      }
      return this.runtime.start(view(item), { id: taskId, confirmed, workItem: { id, revision: expected } });
    });
  }
}
