import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { memoryProject } from "./memory-sources.js";
import { atomicJson, readJson, SerialQueue } from "./util.js";
import { explicitInstant } from './routine-schedule.js';

export type WorkItemLink = { id: string; revision: number };
export type WorkItemRun = { id: string; workItem?: WorkItemLink; preparation?: boolean };
export type WorkItemStatus = 'open' | 'parked' | 'done';
export type WorkItemPriority = 'low' | 'normal' | 'high' | 'urgent';
type Planning = { priority: WorkItemPriority; dueDate: string | null; dueAt: string | null; timeZone: string };
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
} & Planning;
type LegacyFields = 'status' | 'archived' | 'completedAt' | keyof Planning;
type StoredWorkItem = Omit<WorkItem, LegacyFields> & Partial<Pick<WorkItem, LegacyFields>> & {
  boardColumn?: string;
  operations?: { requestId: string; fingerprint: string; result: WorkItem }[];
};
export type WorkItemRequest = { requestId: string; project: string };
export type WorkBoardColumn = { id: string; title: string; status: WorkItemStatus };
type WorkBoardItem = WorkItem & { dueDay: string | null };
export type WorkBoard = { project: string; version: string; columns: Array<WorkBoardColumn & { items: WorkBoardItem[] }> };
type BoardReceipt = { version: string; columnId?: string; itemId?: string };
type StoredBoard = { columns: WorkBoardColumn[]; order: Record<string, string[]>;
  operations: Array<{ requestId: string; fingerprint: string; receipt: BoardReceipt }> };
type WorkItemData = { items: StoredWorkItem[]; boards?: Record<string, StoredBoard> };

const defaultColumns: WorkBoardColumn[] = [
  { id: 'open', title: '待办', status: 'open' }, { id: 'parked', title: '搁置', status: 'parked' }, { id: 'done', title: '已完成', status: 'done' },
];

function boardView(project: string, data: WorkItemData): WorkBoard {
  const saved = data.boards?.[project];
  const columns = (saved?.columns ?? defaultColumns).map(column => ({ ...column, items: [] as WorkBoardItem[] }));
  const byId = new Map(columns.map(column => [column.id, column]));
  for (const item of data.items) {
    if (item.project !== project || item.archived) continue;
    const card = view(item);
    const placed = item.boardColumn ? byId.get(item.boardColumn) : undefined;
    const dueDay = card.dueAt ? localCalendarDay(Date.parse(card.dueAt), card.timeZone) : card.dueDate;
    (placed?.status === card.status ? placed : byId.get(card.status))?.items.push({ ...card, dueDay });
  }
  for (const column of columns) {
    const ranks = new Map((saved?.order[column.id] ?? []).map((id, rank) => [id, rank]));
    column.items.sort((a, b) => (ranks.get(a.id) ?? ranks.size) - (ranks.get(b.id) ?? ranks.size));
  }
  const version = createHash('sha256').update(JSON.stringify([project, columns.map(column =>
    [column.id, column.title, column.status, column.items.map(item => [item.id, item.revision])])])).digest('hex');
  return { project, version, columns };
}

function view(item: StoredWorkItem): WorkItem {
  const { id, revision, project, workspace, title, objective, createdAt, updatedAt } = item;
  return { id, revision, project, workspace, title, objective, createdAt, updatedAt,
    priority: item.priority ?? 'normal', dueDate: item.dueDate ?? null, dueAt: item.dueAt ?? null, timeZone: item.timeZone ?? 'UTC',
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
    return view(operation.result);
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

function planning(input: Record<string, unknown>): Partial<Planning> {
  const value: Partial<Planning> = {};
  if (input.priority !== undefined) {
    if (!['low', 'normal', 'high', 'urgent'].includes(input.priority as string)) throw new WorkItemError(400, 'Priority must be low, normal, high or urgent.');
    value.priority = input.priority as WorkItemPriority;
  }
  if (input.dueDate !== undefined) {
    const day = input.dueDate;
    if (day !== null && (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
      !Number.isFinite(Date.parse(day + 'T00:00:00Z')) || new Date(day + 'T00:00:00Z').toISOString().slice(0, 10) !== day)) throw new WorkItemError(400, 'Provide a valid date-only deadline as YYYY-MM-DD, or null.');
    value.dueDate = day as string | null;
  }
  if (input.dueAt !== undefined) {
    if (input.dueAt === null) value.dueAt = null;
    else {
      if (typeof input.dueAt !== 'string') throw new WorkItemError(400, 'Provide a deadline with an explicit UTC offset, or null.');
      try { value.dueAt = new Date(explicitInstant(input.dueAt, 'A deadline')).toISOString(); }
      catch { throw new WorkItemError(400, 'Provide a valid deadline with an explicit UTC offset, or null.'); }
    }
  }
  if (input.timeZone !== undefined) {
    if (typeof input.timeZone !== 'string' || !input.timeZone || input.timeZone.length > 128 || /^[+-]/.test(input.timeZone)) throw new WorkItemError(400, 'Provide a valid IANA time zone.');
    try { value.timeZone = new Intl.DateTimeFormat('en', { timeZone: input.timeZone }).resolvedOptions().timeZone; }
    catch { throw new WorkItemError(400, 'Provide a valid IANA time zone.'); }
  }
  return value;
}

function deadline(item: Pick<Planning, 'dueDate' | 'dueAt'>) {
  if (item.dueDate && item.dueAt) throw new WorkItemError(400, 'Choose a date-only or timed deadline; explicitly clear the previous kind when switching.');
}

function localCalendarDay(instant: number, timeZone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(instant).map(part => [part.type, part.value]));
  return `${parts.year!.padStart(4, '0')}-${parts.month}-${parts.day}`;
}

export function workItemOverdue(item: Pick<WorkItem, 'status' | 'archived' | 'dueDate' | 'dueAt' | 'timeZone'>, now = Date.now()): boolean {
  if (item.archived || item.status === 'done') return false;
  if (item.dueAt) return Date.parse(item.dueAt) < now;
  if (!item.dueDate) return false;
  return item.dueDate < localCalendarDay(now, item.timeZone);
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

  private async loadData(): Promise<WorkItemData> {
    try {
      const saved = await readJson<StoredWorkItem[] | WorkItemData>(this.path);
      if (Array.isArray(saved)) return { items: saved };
      if (!Array.isArray(saved?.items)) throw new Error('Invalid work item data.');
      return saved;
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { items: [] };
      throw error;
    }
  }

  private async load() { return (await this.loadData()).items; }

  private async saveData(data: WorkItemData) { await atomicJson(this.path, data.boards ? data : data.items); }

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

  async board(workspace: string, expectedProject?: string): Promise<WorkBoard> {
    const { project } = await projectFor(workspace);
    if (expectedProject !== undefined && expectedProject !== project) throw new WorkItemError(409, 'The original workboard project changed.');
    return boardView(project, await this.loadData());
  }

  async editBoard(workspace: string, input: unknown, expectedProject?: string): Promise<BoardReceipt> {
    const common = ['action', 'version', 'requestId'];
    const action = (input as { action?: unknown } | null)?.action;
    const extras = action === 'add-column' ? ['title', 'status'] : action === 'rename-column' ? ['columnId', 'title'] :
      action === 'remove-column' ? ['columnId'] : action === 'reorder-columns' ? ['columnIds'] :
      action === 'move-card' ? ['itemId', 'itemRevision', 'columnId', 'beforeId'] : undefined;
    if (!extras) throw new WorkItemError(400, 'Choose a workboard action.');
    const value = fields(input, [...common, ...extras]);
    if (typeof value.version !== 'string' || !/^[a-f0-9]{64}$/.test(value.version) || typeof value.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(value.requestId)) {
      throw new WorkItemError(400, 'Provide the displayed board version and a request ID.');
    }
    const requestId = value.requestId;
    const fingerprint = createHash('sha256').update(JSON.stringify([action, value.version, ...extras.map(key => value[key])])).digest('hex');
    const { project } = await projectFor(workspace);
    if (expectedProject !== undefined && expectedProject !== project) throw new WorkItemError(409, 'The original workboard project changed.');
    return this.changes.run(async () => {
      const data = await this.loadData(), current = boardView(project, data);
      const board: StoredBoard = data.boards?.[project] ?? { columns: defaultColumns.map(column => ({ ...column })), order: {}, operations: [] };
      const prior = board.operations.find(operation => operation.requestId === requestId);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new WorkItemError(409, 'The board request already has different content.');
        return prior.receipt;
      }
      if (current.version !== value.version) throw new WorkItemError(409, 'The workboard changed. Read the current board.');
      let columnId: string | undefined, itemId: string | undefined;
      if (action === 'add-column') {
        const column = { id: randomUUID(), title: text(value.title, 'column title', 80), status: status(value.status) };
        board.columns.push(column);
        columnId = column.id;
      } else if (action === 'reorder-columns') {
        if (!Array.isArray(value.columnIds) || value.columnIds.length !== board.columns.length || new Set(value.columnIds).size !== board.columns.length ||
          value.columnIds.some(id => !board.columns.some(column => column.id === id))) throw new WorkItemError(400, 'Provide each current column once.');
        board.columns = value.columnIds.map(id => board.columns.find(column => column.id === id)!);
      } else {
        const column = board.columns.find(entry => entry.id === value.columnId);
        const visible = current.columns.find(entry => entry.id === value.columnId);
        if (!column || !visible) throw new WorkItemError(404, 'Column not found in this board.');
        columnId = column.id;
        if (action === 'rename-column') column.title = text(value.title, 'column title', 80);
        else if (action === 'remove-column') {
          if (defaultColumns.some(entry => entry.id === column.id)) throw new WorkItemError(400, 'The default status columns belong to the work item lifecycle.');
          if (visible.items.length) throw new WorkItemError(409, 'Move the cards before removing this column.');
          board.columns = board.columns.filter(entry => entry !== column);
          delete board.order[column.id];
        } else {
          const item = data.items.find(entry => entry.id === value.itemId && entry.project === project && !entry.archived);
          if (!item) throw new WorkItemError(404, 'Work item not found in this project board.');
          if (item.revision !== revision(value.itemRevision)) throw new WorkItemError(409, 'The work item changed. Read its latest revision.');
          const selected = visible.items.filter(card => card.id !== item.id).map(card => card.id);
          const at = value.beforeId === undefined || value.beforeId === null ? selected.length : selected.findIndex(id => id === value.beforeId);
          if (at < 0) throw new WorkItemError(409, 'The reference card is unavailable in this column.');
          for (const id of Object.keys(board.order)) board.order[id] = board.order[id]!.filter(card => card !== item.id);
          selected.splice(at, 0, item.id);
          board.order[column.id] = selected;
          item.boardColumn = column.id;
          item.updatedAt = Date.now();
          item.revision++;
          if ((item.status ?? 'open') !== column.status) {
            item.status = column.status;
            item.completedAt = column.status === 'done' ? item.updatedAt : null;
          }
          itemId = item.id;
        }
      }
      data.boards = { ...data.boards, [project]: board };
      const receipt = { version: boardView(project, data).version, ...(columnId ? { columnId } : {}), ...(itemId ? { itemId } : {}) };
      board.operations.push({ requestId, fingerprint, receipt });
      await this.saveData(data);
      return receipt;
    });
  }

  async create(input: unknown, request?: WorkItemRequest): Promise<WorkItem> {
    requestKey(request);
    const value = fields(input, ["workspace", "title", "objective", "status", 'priority', 'dueDate', 'dueAt', 'timeZone']);
    const title = text(value.title, "title", 120);
    const objective = text(value.objective, "objective", 32_000);
    const workspace = text(value.workspace, 'workspace', 4096), state = value.status === undefined ? 'open' : status(value.status);
    const plan = planning(value);
    deadline({ dueDate: plan.dueDate ?? null, dueAt: plan.dueAt ?? null });
    // Keep the original digest when planning fields are absent, including pre-upgrade replays.
    const fingerprint = createHash('sha256').update(JSON.stringify(['create', workspace, title, objective, state, request?.project, ...(Object.keys(plan).length ? [plan] : [])])).digest('hex');
    return this.changes.run(async () => {
      const data = await this.loadData(), items = data.items;
      const receipt = request ? replay(items, request.requestId, fingerprint) : undefined;
      if (receipt) return receipt;
      const location = await projectFor(workspace);
      if (request && location.project !== request.project) throw new WorkItemError(409, 'The original work item project changed.');
      const now = Date.now();
      const item: WorkItem = { ...location, id: randomUUID(), title, objective, status: state, archived: false,
        priority: 'normal', dueDate: null, dueAt: null, timeZone: 'UTC', ...plan,
        completedAt: state === 'done' ? now : null, revision: 1, createdAt: now, updatedAt: now };
      await this.saveData({ ...data, items: [...items, { ...item, ...(request ? { operations: [{ requestId: request.requestId, fingerprint, result: item }] } : {}) }] });
      return item;
    });
  }

  async update(id: string, input: unknown, request?: WorkItemRequest): Promise<WorkItem> {
    requestKey(request);
    const value = fields(input, ["revision", "title", "objective", "status", "archived", 'priority', 'dueDate', 'dueAt', 'timeZone']);
    const expected = revision(value.revision);
    const title = value.title === undefined ? undefined : text(value.title, "title", 120);
    const objective = value.objective === undefined ? undefined : text(value.objective, "objective", 32_000);
    const state = value.status === undefined ? undefined : status(value.status);
    if (value.archived !== undefined && typeof value.archived !== 'boolean') throw new WorkItemError(400, 'The archived setting must be a boolean.');
    const archived = value.archived as boolean | undefined;
    const plan = planning(value);
    if (title === undefined && objective === undefined && state === undefined && archived === undefined && !Object.keys(plan).length) throw new WorkItemError(400, "Provide work item fields to update.");
    const fingerprint = createHash('sha256').update(JSON.stringify(['update', id, expected, title, objective, state, archived, request?.project, ...(Object.keys(plan).length ? [plan] : [])])).digest('hex');
    return this.changes.run(async () => {
      const data = await this.loadData(), items = data.items;
      const receipt = request ? replay(items, request.requestId, fingerprint) : undefined;
      if (receipt) return receipt;
      const item = this.find(items, id);
      if (request && item.project !== request.project) throw new WorkItemError(404, 'Work item not found in this project.');
      if (item.revision !== expected) throw new WorkItemError(409, "The work item changed. Read its latest revision.");
      const previous = view(item), next = { ...previous, title: title ?? previous.title, objective: objective ?? previous.objective,
        status: state ?? previous.status, archived: archived ?? previous.archived, ...plan };
      deadline(next);
      const changed = next.title !== previous.title || next.objective !== previous.objective || next.status !== previous.status || next.archived !== previous.archived ||
        next.priority !== previous.priority || next.dueDate !== previous.dueDate || next.dueAt !== previous.dueAt || next.timeZone !== previous.timeZone;
      if (!changed && !request) return previous;
      if (changed) {
        next.revision++; next.updatedAt = Date.now();
        if (next.status !== previous.status) next.completedAt = next.status === 'done' ? next.updatedAt : null;
      }
      const stored = { ...next, boardColumn: next.status === previous.status ? item.boardColumn : undefined,
        operations: request ? [...(item.operations ?? []), { requestId: request.requestId, fingerprint, result: next }] : item.operations };
      await this.saveData({ ...data, items: items.map(previous => previous === item ? stored : previous) });
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
