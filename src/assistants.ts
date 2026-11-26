import { randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import type { Models } from '@earendil-works/pi-ai';
import type { ModelRef } from './config.js';
import { memoryProject } from './memory-sources.js';
import { validateModel } from './models.js';
import { atomicJson, readJson, SerialQueue } from './util.js';

export type AssistantRef = { id: string; revision: number };
type Definition = { name: string; description: string; instructions: string; model: ModelRef | null; tools: string[] };
export type Assistant = AssistantRef & Definition & { project: string; archived: boolean; createdAt: number; updatedAt: number };
export type AssistantPin = AssistantRef & Definition & { project: string; model: ModelRef };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const definitionKeys = ['name', 'description', 'instructions', 'model', 'tools'];
const storedKeys = [...definitionKeys, 'id', 'revision', 'project', 'archived', 'createdAt', 'updatedAt'];
export class AssistantError extends Error { constructor(readonly status: 400 | 404 | 409, message: string) { super(message); } }

function fields(input: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))) throw new AssistantError(400, 'Invalid assistant fields.');
  return input as Record<string, unknown>;
}
function revision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new AssistantError(400, 'Provide the displayed assistant revision.');
  return value;
}
export function assistantRef(input: unknown): AssistantRef {
  const value = fields(input, ['id', 'revision']);
  if (typeof value.id !== 'string' || !uuid.test(value.id)) throw new AssistantError(400, 'Provide an assistant ID and revision.');
  return { id: value.id, revision: revision(value.revision) };
}
function text(value: unknown, label: string, limit: number, blank = false): string {
  if (typeof value !== 'string' || !blank && !value.trim() || value.length > limit || value.includes('\0')) throw new AssistantError(400, `Provide assistant ${label} of up to ${limit} characters.`);
  return value;
}
function modelRef(input: unknown): ModelRef | null {
  if (input === null || input === undefined) return null;
  const value = fields(input, ['provider', 'modelId']);
  return { provider: text(value.provider, 'model provider', 128).trim(), modelId: text(value.modelId, 'model ID', 256).trim() };
}
function definition(input: Record<string, unknown>): Definition {
  const name = text(input.name, 'name', 80).trim().normalize('NFC');
  if (/[\x00-\x1f\x7f]/.test(name)) throw new AssistantError(400, 'Provide a single-line assistant name without terminal controls.');
  if (!Array.isArray(input.tools) || input.tools.length > 128 || input.tools.some(name => typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.:-]{0,255}$/.test(name)) ||
    new Set(input.tools).size !== input.tools.length) throw new AssistantError(400, 'Provide an explicit array of up to 128 distinct tool names, without wildcards.');
  return { name, description: input.description === undefined ? '' : text(input.description, 'description', 1000, true).trim(),
    instructions: text(input.instructions, 'instructions', 16_000), model: modelRef(input.model), tools: [...input.tools].sort() };
}
const nameKey = (name: string) => name.trim().normalize('NFC').toLowerCase();
async function projectFor(workspace: unknown): Promise<string> {
  if (typeof workspace !== 'string' || !isAbsolute(workspace)) throw new AssistantError(400, 'Provide an existing absolute project workspace.');
  const project = await memoryProject(workspace);
  if (!project) throw new AssistantError(400, 'Provide an existing project workspace.');
  return project;
}

export class Assistants {
  private readonly path: string;
  private readonly changes = new SerialQueue();
  constructor(dataDir: string, private readonly models: Models) { this.path = join(dataDir, 'assistants.json'); }
  private async load(): Promise<Assistant[]> {
    let input: unknown;
    try { input = await readJson(this.path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new AssistantError(400, 'Stored assistant definitions could not be read.');
    }
    try {
      if (!Array.isArray(input)) throw new Error('Invalid catalog.');
      const ids = new Set<string>(), names = new Set<string>();
      for (const item of input) {
        const value = fields(item, storedKeys); definition(value);
        if (!storedKeys.every(key => Object.hasOwn(value, key)) || typeof value.id !== 'string' || !uuid.test(value.id) ||
          typeof value.project !== 'string' || !isAbsolute(value.project) || typeof value.archived !== 'boolean' ||
          typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt) || value.createdAt < 0 ||
          typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt) || value.updatedAt < 0) throw new Error('Invalid stored identity.');
        revision(value.revision);
        const name = JSON.stringify([value.project, nameKey(value.name as string)]);
        if (ids.has(value.id) || names.has(name)) throw new Error('Duplicate stored identity.');
        ids.add(value.id); names.add(name);
      }
    } catch { throw new AssistantError(400, 'Stored assistant definitions are invalid.'); }
    return input as Assistant[];
  }
  private find(items: Assistant[], id: string): Assistant {
    const found = items.find(item => item.id === id);
    if (!found) throw new AssistantError(404, 'Assistant not found.');
    return found;
  }
  private checkModel(model: ModelRef | null) {
    if (model) try { validateModel(this.models, model); }
    catch { throw new AssistantError(400, 'Choose an assistant model from the installed Pi catalog.'); }
  }
  private unique(items: Assistant[], project: string, name: string, except?: string) {
    if (items.some(item => item.project === project && item.id !== except && nameKey(item.name) === nameKey(name))) throw new AssistantError(409, 'This project already has an assistant with that name.');
  }
  async list(workspace: unknown): Promise<Omit<Assistant, 'instructions'>[]> {
    const project = await projectFor(workspace);
    return (await this.load()).filter(item => item.project === project).map(({ instructions: _instructions, ...summary }) => summary);
  }
  async get(id: string): Promise<Assistant> { return this.find(await this.load(), id); }
  async create(input: unknown): Promise<Assistant> {
    const value = fields(input, ['workspace', ...definitionKeys]), settings = definition(value); this.checkModel(settings.model);
    return this.changes.run(async () => {
      const project = await projectFor(value.workspace), items = await this.load(); this.unique(items, project, settings.name);
      const now = Date.now(), next: Assistant = { ...settings, project, id: randomUUID(), revision: 1, archived: false, createdAt: now, updatedAt: now };
      await atomicJson(this.path, [...items, next]); return next;
    });
  }
  async update(id: string, input: unknown): Promise<Assistant> {
    const supplied = fields(input, ['revision', ...definitionKeys, 'archived']);
    const value = Object.fromEntries(Object.entries(supplied).filter(([, field]) => field !== undefined)), expected = revision(value.revision);
    if (!Object.keys(value).some(key => key !== 'revision')) throw new AssistantError(400, 'Provide assistant fields to update.');
    if (value.archived !== undefined && typeof value.archived !== 'boolean') throw new AssistantError(400, 'The archived setting must be a boolean.');
    return this.changes.run(async () => {
      const items = await this.load(), previous = this.find(items, id);
      if (previous.revision !== expected) throw new AssistantError(409, 'The assistant changed. Read its latest revision.');
      const settings = definition({ ...previous, ...value });
      if (Object.hasOwn(value, 'model')) this.checkModel(settings.model);
      this.unique(items, previous.project, settings.name, id);
      const next: Assistant = { ...previous, ...settings, archived: value.archived as boolean | undefined ?? previous.archived };
      if (JSON.stringify(next) === JSON.stringify(previous)) return previous;
      next.revision = revision(previous.revision + 1); next.updatedAt = Date.now();
      await atomicJson(this.path, items.map(item => item.id === id ? next : item)); return next;
    });
  }
  async select(workspace: unknown, input: unknown): Promise<Assistant> {
    const ref = assistantRef(input), project = await projectFor(workspace), item = await this.get(ref.id);
    if (item.project !== project) throw new AssistantError(404, 'Assistant not found in this project.');
    if (item.revision !== ref.revision || item.archived) throw new AssistantError(409, 'Select the current unarchived assistant revision.');
    this.checkModel(item.model); return item;
  }
}
