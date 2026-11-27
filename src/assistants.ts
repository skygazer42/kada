import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import type { Models } from '@earendil-works/pi-ai';
import type { ModelRef } from './config.js';
import { memoryProject } from './memory-sources.js';
import { validateModel } from './models.js';
import { atomicJson, readJson, SerialQueue } from './util.js';

export type AssistantRef = { id: string; revision: number };
type Definition = { name: string; description: string; instructions: string; model: ModelRef | null; tools: string[]; memoryScope?: 'shared' | 'isolated' };
export type Assistant = AssistantRef & Definition & { project: string; archived: boolean; createdAt: number; updatedAt: number };
export type AssistantPin = AssistantRef & Definition & { project: string; model: ModelRef };
export type AssistantMutation = { requestId: string; project: string; workspace: string };
type StoredAssistant = Assistant & { operations?: { requestId: string; fingerprint: string; result: Assistant }[] };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const requiredDefinitionKeys = ['name', 'description', 'instructions', 'model', 'tools'];
const definitionKeys = [...requiredDefinitionKeys, 'memoryScope'];
const requiredStoredKeys = [...requiredDefinitionKeys, 'id', 'revision', 'project', 'archived', 'createdAt', 'updatedAt'];
const storedKeys = [...requiredStoredKeys, 'memoryScope'];
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
function assistantName(input: unknown): string {
  const name = text(input, 'name', 80).trim().normalize('NFC');
  if (/[\x00-\x1f\x7f]/.test(name)) throw new AssistantError(400, 'Provide a single-line assistant name without terminal controls.');
  return name;
}
function toolNames(input: unknown): string[] {
  if (!Array.isArray(input) || input.length > 128 || input.some(name => typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.:-]{0,255}$/.test(name)) ||
    new Set(input).size !== input.length) throw new AssistantError(400, 'Provide an explicit array of up to 128 distinct tool names, without wildcards.');
  return [...input].sort();
}
function memoryScope(input: unknown): 'shared' | 'isolated' {
  if (input !== 'shared' && input !== 'isolated') throw new AssistantError(400, 'Choose shared or isolated assistant memory.');
  return input;
}
function definition(input: Record<string, unknown>): Definition {
  return { name: assistantName(input.name), description: input.description === undefined ? '' : text(input.description, 'description', 1000, true).trim(),
    instructions: text(input.instructions, 'instructions', 16_000), model: modelRef(input.model), tools: toolNames(input.tools),
    ...(input.memoryScope === undefined ? {} : { memoryScope: memoryScope(input.memoryScope) }) };
}
const nameKey = (name: string) => name.trim().normalize('NFC').toLowerCase();
export async function assistantProject(workspace: unknown): Promise<string> {
  if (typeof workspace !== 'string' || !isAbsolute(workspace)) throw new AssistantError(400, 'Provide an existing absolute project workspace.');
  const project = await memoryProject(workspace);
  if (!project) throw new AssistantError(400, 'Provide an existing project workspace.');
  return project;
}
function publicAssistant(item: Assistant): Assistant {
  const { id, revision, project, name, description, instructions, model, tools, archived, createdAt, updatedAt, memoryScope } = item;
  return { id, revision, project, name, description, instructions, model, tools, archived, createdAt, updatedAt, ...(memoryScope ? { memoryScope } : {}) };
}
function storedAssistant(input: unknown, allowed: readonly string[] = storedKeys): Assistant {
  const value = fields(input, allowed); definition(value);
  if (!requiredStoredKeys.every(key => Object.hasOwn(value, key)) || typeof value.id !== 'string' || !uuid.test(value.id) ||
    typeof value.project !== 'string' || !isAbsolute(value.project) || typeof value.archived !== 'boolean' ||
    typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt) || value.createdAt < 0 ||
    typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt) || value.updatedAt < 0) throw new Error('Invalid stored identity.');
  revision(value.revision); return value as Assistant;
}
function mutationRequest(request?: AssistantMutation) {
  if (request && (typeof request.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(request.requestId) ||
    typeof request.project !== 'string' || !isAbsolute(request.project) || typeof request.workspace !== 'string' || !isAbsolute(request.workspace))) throw new AssistantError(400, 'Provide the original assistant request and project scope.');
}
function replay(items: StoredAssistant[], request: AssistantMutation | undefined, fingerprint: string): Assistant | undefined {
  if (request) for (const item of items) for (const operation of item.operations ?? []) if (operation.requestId === request.requestId) {
    if (operation.fingerprint !== fingerprint) throw new AssistantError(409, 'This assistant request already has different content.');
    return publicAssistant(operation.result);
  }
}
async function mutationScope(request?: AssistantMutation) {
  if (request && await assistantProject(request.workspace) !== request.project) throw new AssistantError(409, 'The original assistant project changed.');
}

export class Assistants {
  private readonly path: string;
  private readonly changes = new SerialQueue();
  constructor(dataDir: string, private readonly models: Models) { this.path = join(dataDir, 'assistants.json'); }
  private async load(): Promise<StoredAssistant[]> {
    let input: unknown;
    try { input = await readJson(this.path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new AssistantError(400, 'Stored assistant definitions could not be read.');
    }
    try {
      if (!Array.isArray(input)) throw new Error('Invalid catalog.');
      const ids = new Set<string>(), names = new Set<string>(), requests = new Set<string>();
      for (const item of input) {
        const value = storedAssistant(item, [...storedKeys, 'operations']) as StoredAssistant;
        const name = JSON.stringify([value.project, nameKey(value.name)]);
        if (ids.has(value.id) || names.has(name)) throw new Error('Duplicate stored identity.');
        ids.add(value.id); names.add(name);
        if (value.operations !== undefined) {
          if (!Array.isArray(value.operations)) throw new Error('Invalid operations.');
          for (const operation of value.operations) {
            fields(operation, ['requestId', 'fingerprint', 'result']);
            if (typeof operation.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(operation.requestId) ||
              typeof operation.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(operation.fingerprint) || requests.has(operation.requestId)) throw new Error('Invalid operation identity.');
            const result = storedAssistant(operation.result);
            if (result.id !== value.id || result.project !== value.project || result.revision > value.revision) throw new Error('Invalid operation result.');
            requests.add(operation.requestId);
          }
        }
      }
    } catch { throw new AssistantError(400, 'Stored assistant definitions are invalid.'); }
    return input as StoredAssistant[];
  }
  private find(items: StoredAssistant[], id: string): StoredAssistant {
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
  async list(workspace: unknown, expectedProject?: string): Promise<Omit<Assistant, 'instructions'>[]> {
    const project = await assistantProject(workspace);
    if (expectedProject !== undefined && project !== expectedProject) throw new AssistantError(409, 'The original assistant project changed.');
    return (await this.load()).filter(item => item.project === project).map(item => { const { instructions: _instructions, ...summary } = publicAssistant(item); return summary; });
  }
  async get(id: string): Promise<Assistant> { return publicAssistant(this.find(await this.load(), id)); }
  async create(input: unknown, request?: AssistantMutation): Promise<Assistant> {
    mutationRequest(request);
    const value = fields(input, ['workspace', ...definitionKeys]), settings = definition(value);
    const fingerprint = createHash('sha256').update(JSON.stringify(['create', value.workspace, settings, request?.project, request?.workspace])).digest('hex');
    return this.changes.run(async () => {
      const items = await this.load(), receipt = replay(items, request, fingerprint); if (receipt) return receipt;
      await mutationScope(request);
      const project = await assistantProject(value.workspace);
      if (request && project !== request.project) throw new AssistantError(409, 'The original assistant project changed.');
      this.checkModel(settings.model); this.unique(items, project, settings.name);
      const now = Date.now(), next: Assistant = { ...settings, project, id: randomUUID(), revision: 1, archived: false, createdAt: now, updatedAt: now };
      await atomicJson(this.path, [...items, { ...next, ...(request ? { operations: [{ requestId: request.requestId, fingerprint, result: next }] } : {}) }]); return next;
    });
  }
  async update(id: string, input: unknown, request?: AssistantMutation): Promise<Assistant> {
    mutationRequest(request);
    const supplied = fields(input, ['revision', ...definitionKeys, 'archived']);
    const value = Object.fromEntries(Object.entries(supplied).filter(([, field]) => field !== undefined)), expected = revision(value.revision);
    if (!Object.keys(value).some(key => key !== 'revision')) throw new AssistantError(400, 'Provide assistant fields to update.');
    if (value.archived !== undefined && typeof value.archived !== 'boolean') throw new AssistantError(400, 'The archived setting must be a boolean.');
    const patch = { ...(value.name === undefined ? {} : { name: assistantName(value.name) }),
      ...(value.description === undefined ? {} : { description: text(value.description, 'description', 1000, true).trim() }),
      ...(value.instructions === undefined ? {} : { instructions: text(value.instructions, 'instructions', 16_000) }),
      ...(value.model === undefined ? {} : { model: modelRef(value.model) }), ...(value.tools === undefined ? {} : { tools: toolNames(value.tools) }),
      ...(value.archived === undefined ? {} : { archived: value.archived as boolean }),
      ...(value.memoryScope === undefined ? {} : { memoryScope: memoryScope(value.memoryScope) }) };
    const fingerprint = createHash('sha256').update(JSON.stringify(['update', id, expected, patch, request?.project, request?.workspace])).digest('hex');
    return this.changes.run(async () => {
      const items = await this.load(), receipt = replay(items, request, fingerprint); if (receipt) return receipt;
      await mutationScope(request);
      const stored = this.find(items, id), previous = publicAssistant(stored);
      if (request && previous.project !== request.project) throw new AssistantError(404, 'Assistant not found in this project.');
      if (previous.revision !== expected) throw new AssistantError(409, 'The assistant changed. Read its latest revision.');
      if (Object.hasOwn(patch, 'model')) this.checkModel(patch.model!);
      this.unique(items, previous.project, patch.name ?? previous.name, id);
      const next: Assistant = { ...previous, ...patch }, changed = JSON.stringify(next) !== JSON.stringify(previous);
      if (!changed && !request) return previous;
      if (changed) { next.revision = revision(previous.revision + 1); next.updatedAt = Date.now(); }
      const operations = request ? [...(stored.operations ?? []), { requestId: request.requestId, fingerprint, result: next }] : stored.operations;
      await atomicJson(this.path, items.map(item => item.id === id ? { ...next, ...(operations ? { operations } : {}) } : item)); return next;
    });
  }
  async select(workspace: unknown, input: unknown): Promise<Assistant> {
    const ref = assistantRef(input), project = await assistantProject(workspace), item = await this.get(ref.id);
    if (item.project !== project) throw new AssistantError(404, 'Assistant not found in this project.');
    if (item.revision !== ref.revision || item.archived) throw new AssistantError(409, 'Select the current unarchived assistant revision.');
    this.checkModel(item.model); return item;
  }
}
