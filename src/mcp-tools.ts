import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Type } from '@earendil-works/pi-ai';
import { defineTool } from '@earendil-works/pi-durable';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult, Tool as ServerTool } from '@modelcontextprotocol/sdk/types.js';
import { memoryProject } from './memory-sources.js';
import { atomicJson, readJson, SerialQueue } from './util.js';

export type McpDefinition = { id: string } & (
  | { transport: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { transport: 'http'; url: string; headers?: Record<string, string> }
);
export type McpPin = { id: string; revision: string; tools: string[]; discovery?: FoundTool[] };
export type ProjectMcpTool = { id: string; tool: string };
type FoundTool = Pick<ServerTool, 'name' | 'description' | 'inputSchema'>;
type McpTest = { checkedAt: string; tools?: FoundTool[] } & (
  | { status: 'ok'; tools: FoundTool[] }
  | { status: 'failed'; message: string }
);
type SavedConnection = { definition: McpDefinition; revision: string; allowedTools: string[]; enabled: boolean; test?: McpTest };
export type McpConnection = Omit<SavedConnection, 'definition' | 'test'> & {
  id: string;
  transport: McpDefinition['transport'];
  test?: Omit<McpTest, 'tools'> & { message?: string; tools?: Array<Pick<FoundTool, 'name' | 'description'>> };
};

const pinOf = (connection: SavedConnection): McpPin => ({
  id: connection.definition.id,
  revision: connection.revision,
  tools: connection.allowedTools,
  discovery: connection.test?.tools?.filter(tool => connection.allowedTools.includes(tool.name)),
});

const idPattern = /^[a-z0-9][a-z0-9-]{0,31}$/;
const envPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const headerPattern = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

async function projectRoot(workspace: string): Promise<string> {
  const project = await memoryProject(workspace);
  if (!project) throw new Error('The MCP settings workspace must be an existing directory.');
  return project;
}

function validProjectTools(value: unknown): value is ProjectMcpTool[] {
  return Array.isArray(value) && value.every(entry => entry && typeof entry.id === 'string' &&
    idPattern.test(entry.id) && typeof entry.tool === 'string' && entry.tool.length > 0);
}

function envRefs(entries: Record<string, string> | undefined, keyPattern: RegExp): Record<string, string> | undefined {
  if (entries === undefined) return;
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw new Error('MCP credentials must reference environment variables.');
  const pairs = Object.entries(entries).sort(([a], [b]) => a.localeCompare(b));
  if (pairs.some(([key, ref]) => !keyPattern.test(key) || typeof ref !== 'string' || !envPattern.test(ref))) {
    throw new Error('MCP credentials must reference environment variables.');
  }
  return Object.fromEntries(pairs);
}

function normalize(def: McpDefinition): McpDefinition {
  if (!def || typeof def.id !== 'string' || !idPattern.test(def.id)) throw new Error('MCP id must be 1–32 lowercase letters, digits or hyphens.');
  if (def.transport === 'stdio') {
    if (typeof def.command !== 'string' || !def.command.trim()) throw new Error('A local MCP command is required.');
    if (def.args !== undefined && (!Array.isArray(def.args) || def.args.some(arg => typeof arg !== 'string'))) throw new Error('MCP command arguments must be strings.');
    return { id: def.id, transport: def.transport, command: def.command, args: def.args ?? [], env: envRefs(def.env, envPattern) };
  }
  if (def.transport === 'http') {
    let url: URL;
    try {
      url = new URL(def.url);
    } catch {
      throw new Error('An absolute HTTP or HTTPS MCP endpoint is required.');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('Use an HTTP or HTTPS MCP endpoint with credentials supplied by environment-backed headers.');
    }
    return { id: def.id, transport: def.transport, url: url.href, headers: envRefs(def.headers, headerPattern) };
  }
  throw new Error('Unsupported MCP transport.');
}

function resolveEnv(refs: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(refs ?? {}).map(([key, name]) => {
    const value = process.env[name];
    if (!value) throw new Error('A configured MCP environment variable is missing.');
    return [key, value];
  }));
}

function hasCredential(value: unknown, credentials: string[]): boolean {
  if (typeof value === 'string') return credentials.some(credential =>
    value === credential || (credential.length >= 8 && value.includes(credential)));
  if (Array.isArray(value)) return value.some(item => hasCredential(item, credentials));
  if (value && typeof value === 'object') return Object.entries(value).some(([key, item]) =>
    hasCredential(key, credentials) || hasCredential(item, credentials));
  return false;
}

function status(connection: SavedConnection): McpConnection {
  const { definition, test, ...publicFields } = connection;
  return {
    id: definition.id, transport: definition.transport, ...publicFields,
    test: test && (test.status === 'ok'
      ? { status: 'ok', checkedAt: test.checkedAt, tools: test.tools.map(({ name, description }) => ({ name, description })) }
      : { status: 'failed', checkedAt: test.checkedAt, message: test.message }),
  };
}

function toolName(id: string, name: string): string {
  const prefix = `mcp_${id}_`;
  const suffix = createHash('sha256').update(name).digest('hex').slice(0, 12);
  return `${prefix}${name.replace(/[^\w-]/g, '_').slice(0, 63 - prefix.length - suffix.length)}_${suffix}`;
}

async function discover(client: Client, signal: AbortSignal): Promise<FoundTool[]> {
  const tools = new Map<string, FoundTool>();
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : {}, { signal });
    for (const { name, description, inputSchema } of page.tools) {
      if (!name || tools.has(name)) throw new Error('MCP discovery returned an invalid tool name.');
      tools.set(name, { name, description, inputSchema });
    }
    if (tools.size > 128 || (page.nextCursor && (page.nextCursor === cursor || page.tools.length === 0))) {
      throw new Error('MCP discovery returned too many tools or an invalid page.');
    }
    cursor = page.nextCursor;
  } while (cursor);
  return [...tools.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export class McpTools {
  private readonly path: string;
  private readonly projectsPath: string;
  private readonly changes = new SerialQueue();
  private readonly active = new Set<{ id: string; controller: AbortController; done: Promise<unknown> }>();
  private closed = false;

  constructor(dataDir: string) {
    this.path = join(dataDir, 'mcp-connections.json');
    this.projectsPath = join(dataDir, 'mcp-projects.json');
  }

  private async read(): Promise<SavedConnection[]> {
    try {
      return await readJson<SavedConnection[]>(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  private async update(id: string, change: (old?: SavedConnection) => SavedConnection): Promise<McpConnection> {
    return this.changes.run(async () => {
      const connections = await this.read();
      const previous = connections.find(connection => connection.definition.id === id);
      const next = change(previous);
      await atomicJson(this.path, [...connections.filter(connection => connection !== previous), next]);
      const revoked = previous?.enabled && (!next.enabled || previous.allowedTools.some(name => !next.allowedTools.includes(name)));
      if (previous && (next.revision !== previous.revision || revoked)) {
        this.cancel(id);
      }
      return status(next);
    });
  }

  private require(connection?: SavedConnection): SavedConnection {
    if (!connection) throw new Error('Unknown MCP connection.');
    return connection;
  }

  async list(): Promise<McpConnection[]> {
    return (await this.read()).map(status).sort((a, b) => a.id.localeCompare(b.id));
  }

  configure(definition: McpDefinition): Promise<McpConnection> {
    const normalized = normalize(definition);
    return this.update(normalized.id, old => old && JSON.stringify(old.definition) === JSON.stringify(normalized)
      ? old
      : { definition: normalized, revision: randomUUID(), enabled: false, allowedTools: [] });
  }

  async test(id: string, signal?: AbortSignal): Promise<McpConnection> {
    signal?.throwIfAborted();
    const previous = this.require((await this.read()).find(connection => connection.definition.id === id));
    const checkedAt = new Date().toISOString();
    let test: McpTest;
    try {
      const tools = await this.connect(previous.definition, 15_000, signal, async (client, activeSignal, credentials) => {
        const found = await discover(client, activeSignal);
        if (credentials.length && hasCredential(found, credentials)) throw new Error('Discovery echoed an MCP credential.');
        return found;
      });
      test = { status: 'ok', checkedAt, tools };
    } catch {
      signal?.throwIfAborted();
      if (this.closed) throw new Error('MCP connections have been closed.');
      test = { status: 'failed', checkedAt, message: 'MCP discovery failed. Check the server address or command and its environment settings.' };
    }
    return this.update(id, old => {
      const current = this.require(old);
      if (current.revision !== previous.revision) throw new Error('MCP connection changed during the test. Test the current revision.');
      if ((current.test?.checkedAt ?? '') > checkedAt) return current;
      const changed = current.test?.status === 'ok' && (test.status === 'failed' || JSON.stringify(test.tools) !== JSON.stringify(current.test.tools));
      return { ...current, ...(changed ? { revision: randomUUID() } : {}),
        enabled: current.enabled && !changed && test.status === 'ok',
        allowedTools: changed || test.status !== 'ok' ? [] : current.allowedTools, test };
    });
  }

  enable(id: string, allowedTools: string[], expectedRevision?: string): Promise<McpConnection> {
    if (!Array.isArray(allowedTools) || allowedTools.length === 0 || allowedTools.some(name => typeof name !== 'string')) {
      throw new Error('Select one or more discovered MCP tools to enable.');
    }
    return this.update(id, old => {
      const connection = this.require(old);
      if (expectedRevision !== undefined && expectedRevision !== connection.revision) throw new Error('MCP connection changed. Test the current revision.');
      if (connection.test?.status !== 'ok') throw new Error('Test the current MCP connection before enabling it.');
      const discovered = connection.test.tools;
      if (allowedTools.some(name => !discovered.some(tool => tool.name === name))) throw new Error('Only discovered MCP tools may be enabled.');
      return { ...connection, enabled: true, allowedTools: [...new Set(allowedTools)].sort() };
    });
  }

  disable(id: string): Promise<McpConnection> {
    return this.update(id, old => ({ ...this.require(old), enabled: false }));
  }

  private async readProjects(): Promise<Record<string, ProjectMcpTool[]>> {
    try {
      return await readJson<Record<string, ProjectMcpTool[]>>(this.projectsPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
  }

  async projectTools(workspace: string): Promise<ProjectMcpTool[] | null> {
    const project = await projectRoot(workspace);
    return (await this.readProjects())[project] ?? null;
  }

  async setProjectTools(workspace: string, tools: unknown): Promise<ProjectMcpTool[] | null> {
    if (tools !== null && !validProjectTools(tools)) throw new Error('Provide an array of MCP connection IDs and tool names, or null.');
    const project = await projectRoot(workspace);
    return this.changes.run(async () => {
      const projects = await this.readProjects();
      if (tools === null) {
        if (Object.hasOwn(projects, project)) {
          delete projects[project];
          await atomicJson(this.projectsPath, projects);
        }
        return null;
      }
      const connections = await this.read();
      if (tools.some(({ id, tool }) => !connections.some(connection =>
        connection.enabled && connection.definition.id === id && connection.allowedTools.includes(tool)))) {
        throw new Error('Only currently enabled MCP tools may be selected for a project.');
      }
      const selection = Object.values(Object.fromEntries(tools.map(({ id, tool }) => [JSON.stringify([id, tool]), { id, tool }])));
      projects[project] = selection;
      await atomicJson(this.projectsPath, projects);
      return selection;
    });
  }

  async pins(workspace?: string): Promise<McpPin[]> {
    const selection = workspace === undefined ? null : await this.projectTools(workspace);
    return (await this.read())
      .filter(connection => connection.enabled)
      .map(connection => pinOf(selection === null ? connection : {
        ...connection,
        allowedTools: connection.allowedTools.filter(tool => selection.some(item => item.id === connection.definition.id && item.tool === tool)),
      }))
      .filter(pin => pin.tools.length > 0)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async tools(pins?: McpPin[]) {
    const connections = await this.read();
    const selected = pins ?? connections.filter(connection => connection.enabled).map(pinOf);
    return selected.flatMap(pin => {
      const connection = connections.find(item => item.definition.id === pin.id && item.revision === pin.revision);
      const discovered = pin.discovery ?? connection?.test?.tools;
      return pin.tools.map(name => {
        const tool = discovered?.find(candidate => candidate.name === name);
        return defineTool({
          name: toolName(pin.id, name),
          description: tool?.description ?? `Use the ${name} tool from ${pin.id}.`,
          parameters: Type.Unsafe<Record<string, unknown>>(tool?.inputSchema ?? { type: 'object' }),
          replay: 'unsafe',
          executionMode: 'sequential',
          execute: async (args, _api, context) => {
            const result = await this.call(pin, name, args, context.abortSignal);
            return { output: result.content.map(item => {
              if (item.type === 'text') return { type: 'text' as const, text: item.text };
              if (item.type === 'image') return { type: 'image' as const, data: item.data, mimeType: item.mimeType };
              return { type: 'text' as const, text: `MCP returned a ${item.type} result. This content type is unavailable in Kada.` };
            }), isError: result.isError === true };
          },
        });
      });
    });
  }

  private current(connections: SavedConnection[], pin: McpPin): SavedConnection {
    const connection = this.require(connections.find(item => item.definition.id === pin.id));
    if (connection.revision !== pin.revision) throw new Error(`MCP connection ${pin.id} changed since this task was created.`);
    return connection;
  }

  private async call(pin: McpPin, name: string, args: Record<string, unknown>, signal: AbortSignal | undefined) {
    const pending = await this.changes.run(async () => {
      const connection = this.current(await this.read(), pin);
      if (!connection.enabled || !connection.allowedTools.includes(name)) throw new Error('This MCP tool is no longer enabled or allowed.');
      return { result: this.connect(connection.definition, 60_000, signal, async (client, activeSignal, credentials) => {
        const result = await client.callTool({ name, arguments: args }, undefined, { signal: activeSignal, timeout: 60_000 }) as CallToolResult;
        if (credentials.length && hasCredential(result, credentials)) {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: 'MCP tool response contained a configured credential and was withheld.' }],
          };
        }
        return result;
      }) };
    });
    try {
      return await pending.result;
    } catch {
      signal?.throwIfAborted();
      throw new Error(`MCP tool ${name} could not complete or was cancelled. Check the connection before retrying.`);
    }
  }

  private async connect<T>(definition: McpDefinition, timeout: number, parentSignal: AbortSignal | undefined, action: (client: Client, signal: AbortSignal, credentials: string[]) => Promise<T>): Promise<T> {
    if (this.closed) throw new Error('MCP connections have been closed.');
    const controller = new AbortController();
    const signals = [controller.signal, AbortSignal.timeout(timeout), ...(parentSignal ? [parentSignal] : [])];
    const signal = AbortSignal.any(signals);
    signal.throwIfAborted();
    const settings = resolveEnv(definition.transport === 'stdio' ? definition.env : definition.headers);
    const credentials = Object.values(settings).flatMap(value => {
      const headerValue = /^(?:Bearer|Basic) (.+)$/i.exec(value)?.[1];
      return headerValue ? [value, headerValue] : [value];
    });
    const transport = definition.transport === 'stdio'
      ? new StdioClientTransport({ command: definition.command, args: definition.args, env: settings, stderr: 'ignore' })
      : new StreamableHTTPClientTransport(new URL(definition.url), { requestInit: { headers: settings, redirect: 'error' } });
    const client = new Client({ name: 'kada', version: '1' });
    let closing: Promise<void> | undefined;
    const close = () => closing ??= client.close();
    const closeOnAbort = () => { void close().catch(() => {}); };
    signal.addEventListener('abort', closeOnAbort, { once: true });
    const done = (async () => {
      try {
        await client.connect(transport, { signal });
        signal.throwIfAborted();
        const result = await action(client, signal, credentials);
        signal.throwIfAborted();
        return result;
      } finally {
        signal.removeEventListener('abort', closeOnAbort);
        await close();
      }
    })();
    const tracked = { id: definition.id, controller, done };
    this.active.add(tracked);
    try {
      return await done;
    } finally {
      this.active.delete(tracked);
    }
  }

  private cancel(id?: string): void {
    for (const operation of this.active) if (id === undefined || id === operation.id) operation.controller.abort();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.cancel();
    await Promise.allSettled([...this.active].map(operation => operation.done));
  }
}
