import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { McpTools } from '../src/mcp-tools.js';

test('an approved legacy SSE connection uses its configured headers for stream and tool messages', async t => {
  const data = await mkdtemp(join(tmpdir(), 'kada-mcp-sse-'));
  const workspace = join(data, 'project');
  await mkdir(workspace);
  const token = 'synthetic-' + Date.now() + '-sse';
  const env = 'KADA_TEST_LEGACY_SSE_HEADER';
  process.env[env] = 'Bearer ' + token;
  const methods: string[] = [], sessions = new Map<string, SSEServerTransport>();
  const endpoint = createServer(async (req, res) => {
    methods.push(req.method ?? '');
    if (req.headers.authorization !== 'Bearer ' + token) { res.writeHead(401).end(); return; }
    const path = new URL(req.url!, 'http://127.0.0.1');
    if (path.pathname === '/stream' && req.method === 'GET') {
      const transport = new SSEServerTransport('/messages', res);
      const tools = new Server({ name: 'legacy-fixture', version: '1' }, { capabilities: { tools: {} } });
      tools.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
        { name: 'status', description: 'Read the fixture status.', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
      ] }));
      tools.setRequestHandler(CallToolRequestSchema, async request => {
        assert.equal(request.params.name, 'status');
        return { content: [{ type: 'text', text: 'Legacy status.' }] };
      });
      sessions.set(transport.sessionId, transport);
      res.once('close', () => { sessions.delete(transport.sessionId); });
      await tools.connect(transport);
      return;
    }
    const session = sessions.get(path.searchParams.get('sessionId') ?? '');
    if (path.pathname === '/messages' && req.method === 'POST' && session) { await session.handlePostMessage(req, res); return; }
    res.writeHead(404).end();
  });
  await new Promise<void>(resolve => endpoint.listen(0, '127.0.0.1', resolve));
  const mcp = new McpTools(data);
  t.after(async () => {
    await mcp.close();
    await new Promise<void>(resolve => endpoint.close(() => resolve()));
    delete process.env[env];
    await rm(data, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${(endpoint.address() as { port: number }).port}/stream`;
  const draft = await mcp.proposeConnection(workspace, 'source', '81', { connectionId: 'legacy', endpoint: url, transport: 'sse' });
  assert.equal(draft.transport, 'sse');
  const approval = await mcp.decideConnectionProposal(workspace, 'source', draft.id, 'apply');
  assert.equal(approval.state, 'registered');
  assert.equal(methods.length, 0);
  const registered = (await mcp.list())[0];
  assert.equal(registered?.transport, 'sse');
  assert.equal(registered?.enabled, false);
  await mcp.configure({ id: 'legacy', transport: 'sse', url, headers: { Authorization: env } });
  const checked = await mcp.test('legacy');
  assert.equal(checked.test?.status, 'ok');
  await mcp.enable('legacy', ['status'], checked.revision);
  const [pin] = await mcp.pins(workspace);
  assert(pin);
  const result = await mcp.executeApproved(pin, 'status', {});
  assert.deepEqual(result.output, [{ type: 'text', text: 'Legacy status.' }]);
  assert.equal(methods.filter(method => method === 'GET').length, 2);
  assert(methods.includes('POST'));
  assert(!JSON.stringify(await mcp.list()).includes(token));
});

test('an SSE message endpoint must belong to the originally selected server', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'kada-mcp-sse-origin-'));
  let otherRequests = 0;
  const other = createServer((_req, res) => { otherRequests++; res.writeHead(204).end(); });
  await new Promise<void>(resolve => other.listen(0, '127.0.0.1', resolve));
  const unrelated = `http://127.0.0.1:${(other.address() as { port: number }).port}/messages`;
  const owner = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`event: endpoint\ndata: ${unrelated}\n\n`);
  });
  await new Promise<void>(resolve => owner.listen(0, '127.0.0.1', resolve));
  const mcp = new McpTools(directory);
  t.after(async () => {
    await mcp.close();
    owner.closeAllConnections();
    await Promise.all([new Promise<void>(resolve => owner.close(() => resolve())), new Promise<void>(resolve => other.close(() => resolve()))]);
    await rm(directory, { recursive: true, force: true });
  });
  await mcp.configure({ id: 'same-origin', transport: 'sse', url: `http://127.0.0.1:${(owner.address() as { port: number }).port}/stream` });
  assert.equal((await mcp.test('same-origin')).test?.status, 'failed');
  assert.equal(otherRequests, 0);
});
