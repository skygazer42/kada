import { join } from 'node:path';
import { normalizeMcpPrecheck, projectRoot, type McpPrecheck, type McpTools } from './mcp-tools.js';
import { atomicJson, errorText, readJson, SerialQueue } from './util.js';

type GmailSource = { id: string; revision: string; email: string };

const searchTool = 'search_gmail_messages';
const readTool = 'get_gmail_message_content';
const checksum = /^[a-f0-9]{64}$/;
const control = /[\u0000-\u001f\u007f]/;

export class GmailError extends Error { constructor(readonly status: number, message: string) { super(message); } }

function record(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function parseSource(input: unknown): GmailSource {
  const source = record(input);
  if (!source || Object.keys(source).some(key => !['id', 'revision', 'email'].includes(key))) {
    throw new GmailError(400, 'Provide a Gmail MCP connection, revision and account email.');
  }
  const email = source.email;
  if (typeof email !== 'string' || email.length > 320 || control.test(email) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new GmailError(400, 'Provide the email address for the connected Gmail account.');
  }
  const { id, revision } = normalizeMcpPrecheck({ id: source.id, revision: source.revision, tool: searchTool, arguments: {} });
  return { id, revision, email };
}

export class ProjectGmail {
  private readonly path: string;
  private readonly changes = new SerialQueue();
  constructor(directory: string, private readonly mcp: McpTools) {
    this.path = join(directory, 'project-gmail.json');
  }
  private read(): Promise<Record<string, GmailSource>> {
    return readJson<Record<string, GmailSource>>(this.path).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    });
  }
  async source(workspace: string) {
    const project = await projectRoot(workspace);
    return { project, source: (await this.read())[project] ?? null };
  }
  async setSource(workspace: string, input: unknown) {
    const project = await projectRoot(workspace), source = parseSource(input);
    return this.changes.run(async () => {
      for (const tool of [searchTool, readTool]) {
        await this.checkPermission(project, { id: source.id, revision: source.revision, tool, arguments: {} });
      }
      const values = await this.read();
      values[project] = source;
      await atomicJson(this.path, values);
      return { project, source };
    });
  }
  async clearSource(workspace: string) {
    const project = await projectRoot(workspace);
    return this.changes.run(async () => {
      const values = await this.read();
      if (values[project]) {
        delete values[project];
        await atomicJson(this.path, values);
      }
      return { project, source: null };
    });
  }
  private async checkPermission(project: string, check: McpPrecheck) {
    try { await this.mcp.validatePrecheck(project, check); }
    catch (error) { throw new GmailError(409, errorText(error)); }
  }
  private async call(workspace: string, tool: string, args: McpPrecheck['arguments']) {
    const { project, source } = await this.source(workspace);
    if (!source) throw new GmailError(404, 'Choose a read-only Gmail mailbox for this project first.');
    const check: McpPrecheck = { id: source.id, revision: source.revision, tool, arguments: { ...args, user_google_email: source.email } };
    const ensureSource = async () => {
      const current = (await this.read())[project];
      if (JSON.stringify(current) !== JSON.stringify(source)) throw new GmailError(409, 'The project Gmail source changed.');
    };
    await this.checkPermission(project, check);
    const result = await this.mcp.runReadOnly(project, check, AbortSignal.timeout(30_000), ensureSource).catch(async () => {
      await this.checkPermission(project, check);
      await ensureSource();
      throw new GmailError(502, 'Could not read the configured Gmail mailbox.');
    });
    await this.checkPermission(project, check);
    await ensureSource();
    const text = result.content.length === 1 && result.content[0]?.type === 'text' ? result.content[0].text : undefined;
    if (result.isError) {
      if (tool === readTool && text?.includes('Message representation changed; restart at page_offset=0.')) {
        throw new GmailError(409, 'This message changed. Restart its read at offset 0.');
      }
      throw new GmailError(502, 'The configured Gmail tool reported an error.');
    }
    if (!text || Buffer.byteLength(text) > 1_000_000) throw new GmailError(502, 'The Gmail response was invalid or too large.');
    return text;
  }
  async search(workspace: string, input: Record<string, unknown>) {
    const { query, pageToken, limit = 10 } = input;
    if (Object.keys(input).some(key => !['query', 'pageToken', 'limit'].includes(key)) || typeof query !== 'string' || !query.trim() ||
        query.length > 8192 || control.test(query) || typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 500 ||
        pageToken !== undefined && (typeof pageToken !== 'string' || !pageToken || pageToken.length > 2048 || control.test(pageToken))) {
      throw new GmailError(400, 'Provide a Gmail search query and optional page token or limit.');
    }
    const text = await this.call(workspace, searchTool, { query, page_size: limit, include_headers: true, ...(pageToken ? { page_token: pageToken } : {}) });
    if (text.startsWith('No response received from Gmail API')) throw new GmailError(502, 'Gmail did not return a search response.');
    return { text };
  }
  async message(workspace: string, input: Record<string, unknown>) {
    const { id, offset = 0, sha256 } = input;
    if (Object.keys(input).some(key => !['id', 'offset', 'sha256'].includes(key)) || typeof id !== 'string' || !id.trim() ||
        id.length > 512 || control.test(id) || typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) {
      throw new GmailError(400, 'Provide the original Gmail message ID and a valid page offset.');
    }
    if (sha256 !== undefined && (typeof sha256 !== 'string' || !checksum.test(sha256)) || offset > 0 && sha256 === undefined) {
      throw new GmailError(400, 'Provide the SHA-256 from the original message page.');
    }
    const text = await this.call(workspace, readTool, {
      message_id: id, page_offset: offset, body_format: 'text', format: 'full', full: false, include_headers: true, include_links: false,
      ...(sha256 ? { expected_sha256: sha256 } : {}),
    });
    let page: Record<string, unknown> | undefined;
    try { page = record(JSON.parse(text)); }
    catch { throw new GmailError(502, 'The Gmail provider did not return a message page.'); }
    if (!page || page.message_id !== id || page.body_format !== 'text' || page.page_offset !== offset || typeof page.body !== 'string' ||
        typeof page.body_sha256 !== 'string' || !checksum.test(page.body_sha256) || typeof page.complete !== 'boolean' ||
        (page.complete ? page.next_offset !== null : typeof page.next_offset !== 'number' || !Number.isSafeInteger(page.next_offset) || page.next_offset <= offset)) {
      throw new GmailError(502, 'The Gmail provider returned an invalid message page.');
    }
    if (sha256 && page.body_sha256 !== sha256) throw new GmailError(409, 'This message changed. Restart its read at offset 0.');
    return page;
  }
}
