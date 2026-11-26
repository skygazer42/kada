import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fauxAssistantMessage, fauxToolCall, getCurrentTools } from '@earendil-works/pi-ai';
import { ChatSession } from '../src/chat.js';
import { createClient } from '../src/client.js';
import { serve } from '../src/server.js';
import { McpTools } from '../src/mcp-tools.js';
import { hasTool, recoveryTestTimeoutMs, scriptedFixture, startRecoveryWorker, until } from './helpers.js';
import { startMcpProposalService } from './fixtures/mcp-proposal-service.js';

test('an approved MCP proposal registers once without contacting the service or replacing an existing definition', async t => {
  const data = await mkdtemp(join(tmpdir(), 'kada-mcp-proposal-'));
  const project = join(data, 'project'), other = join(data, 'other');
  await Promise.all([mkdir(project), mkdir(other)]);
  let requests = 0;
  const endpoint = createServer((_req, res) => { requests++; res.writeHead(204).end(); });
  await new Promise<void>(resolve => endpoint.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise<void>(resolve => endpoint.close(() => resolve())); await rm(data, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${(endpoint.address() as { port: number }).port}/mcp`;
  const first = new McpTools(data);
  await first.configure({ id: 'existing', transport: 'http', url });
  assert(Array.isArray(JSON.parse(await readFile(join(data, 'mcp-connections.json'), 'utf8'))));
  const proposed = await first.proposeConnection(project, 'source', '31', { connectionId: 'new-service', endpoint: url });
  assert.equal(proposed.state, 'pending');
  assert.deepEqual((await first.list()).map(connection => connection.id), ['existing']);
  const mcp = new McpTools(data);
  assert.deepEqual(await mcp.connectionProposals(project, 'source'), [proposed]);
  await assert.rejects(mcp.decideConnectionProposal(other, 'source', '31', 'apply'), /not found/i);
  await assert.rejects(mcp.proposeConnection(project, 'source', '32', { connectionId: 'existing', endpoint: url }), /already exists/i);
  await assert.rejects(mcp.proposeConnection(project, 'source', '33', { connectionId: 'bad', endpoint: url + '?token=fixture' }), /credentials|endpoint/i);
  const registered = await Promise.all([mcp.decideConnectionProposal(project, 'source', '31', 'apply'), mcp.decideConnectionProposal(project, 'source', '31', 'apply')]);
  assert.deepEqual(registered[0], registered[1]);
  assert.equal(registered[0].state, 'registered');
  const connection = (await mcp.list()).find(value => value.id === 'new-service');
  assert.equal(connection?.enabled, false);
  assert.equal(connection?.test, undefined);
  const newer = await mcp.configure({ id: 'new-service', transport: 'http', url: url + '/later' });
  assert.deepEqual(await mcp.decideConnectionProposal(project, 'source', '31', 'apply'), registered[0]);
  assert.equal((await mcp.list()).find(value => value.id === 'new-service')?.revision, newer.revision);
  const next = await mcp.proposeConnection(project, 'source', '34', { connectionId: 'race', endpoint: url });
  assert.equal(next.state, 'pending');
  await mcp.configure({ id: 'race', transport: 'http', url: url + '/manual' });
  await assert.rejects(mcp.decideConnectionProposal(project, 'source', '34', 'apply'), /already exists/i);
  assert.equal((await mcp.decideConnectionProposal(project, 'source', '34', 'decline')).state, 'declined');
  assert.equal(requests, 0);
});

test('SIGKILL after registering an MCP proposal retains its receipt and a later owner definition', { timeout: recoveryTestTimeoutMs }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'kada-mcp-proposal-recovery-')));
  const fixture = new URL('./fixtures/mcp-proposal-worker.ts', import.meta.url);
  let worker = startRecoveryWorker(fixture, 'create', directory);
  try {
    const original = await worker.ready();
    assert.equal(await worker.stop(), 'SIGKILL');
    worker = startRecoveryWorker(fixture, 'recover', directory);
    const result = await worker.complete();
    assert.deepEqual(result.receipt, original.receipt);
    assert.equal(result.connections, 1);
    assert.equal(result.currentRevision, result.laterRevision);
    assert.notEqual(result.currentRevision, original.receipt.connectionRevision);
  } finally { await worker.stop(); await rm(directory, { recursive: true, force: true, maxRetries: 5 }); }
});

test('a local chat registers an owner-approved HTTP MCP and new work uses only the tested selected tool', async t => {
  const { address, methods, close } = await startMcpProposalService();
  t.after(close);
  const f = await scriptedFixture(context => {
    if (hasTool(context, 'task_submit')) {
      const tools = getCurrentTools(context.messages).filter(tool => tool.name.startsWith('mcp_linked-service_'));
      assert.equal(tools.length, 1);
      assert.match(tools[0]!.name, /_status_/);
      if (!context.messages.some(message => message.role === 'toolResult' && message.toolName === tools[0]!.name)) {
        return fauxAssistantMessage(fauxToolCall(tools[0]!.name, {}), { stopReason: 'toolUse' });
      }
      assert(JSON.stringify(context.messages).includes('PROPOSAL_TOOL_RESULT'));
      return fauxAssistantMessage(fauxToolCall('task_submit', { summary: 'Read selected status.', artifacts: [] }), { stopReason: 'toolUse' });
    }
    const input = context.messages.findLast(message => message.role === 'user');
    if (input?.content === 'Remote test') assert(!hasTool(context, 'propose_mcp_connection'));
    if (input?.content === 'Set an empty project MCP scope.') {
      const results = context.messages.filter(message => message.role === 'toolResult');
      if (!results.some(result => result.toolName === 'mcp_settings_catalog')) return fauxAssistantMessage(fauxToolCall('mcp_settings_catalog', {}), { stopReason: 'toolUse' });
      if (!results.some(result => result.toolName === 'propose_project_mcp_tools')) return fauxAssistantMessage(fauxToolCall('propose_project_mcp_tools', { tools: [] }), { stopReason: 'toolUse' });
    }
    if (input?.content === 'Propose the sample connection.' && !context.messages.some(message => message.role === 'toolResult' && message.toolName === 'propose_mcp_connection')) {
      assert(hasTool(context, 'propose_mcp_connection'));
      return fauxAssistantMessage(fauxToolCall('propose_mcp_connection', { connectionId: 'linked-service', endpoint: address }), { stopReason: 'toolUse' });
    }
    return fauxAssistantMessage('Ready.');
  });
  await f.runtime.close();
  const socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const config = { ...f.settings, port };
  let daemon = await serve(config, { models: f.models });
  t.after(async () => { await daemon.close(); await f.close(); });
  const client = createClient(config), output: string[] = [];
  const terminal = new ChatSession(client, event => output.push(event.text), f.workspace);
  await terminal.handle('Propose the sample connection.');
  const id = terminal.taskId!;
  await until(() => daemon.runtime.status(id), state => state.status === 'answered');
  await terminal.poll();
  assert(output.some(text => text.includes('/mcp-proposals')));
  const [proposal] = await daemon.runtime.mcpConnectionProposals(id);
  assert(proposal?.state === 'pending');
  assert.equal(proposal.endpoint, address);
  assert.equal((await daemon.runtime.mcp.list()).length, 0);
  assert.deepEqual(methods, []);
  await daemon.close(); daemon = await serve(config, { models: f.models });
  const route = `/v1/tasks/${id}/mcp-proposals/${proposal.id}`;
  assert.equal((await fetch(`http://127.0.0.1:${port}${route}`, { method: 'POST', body: '{"decision":"apply"}' })).status, 401);
  await terminal.attach(id);
  await terminal.handle('/mcp-proposals');
  assert(output.some(text => text.includes(address) && text.includes(`/apply-mcp ${proposal.id}`)));
  await terminal.handle(`/apply-mcp ${proposal.id}`);
  await terminal.handle(`/apply-mcp ${proposal.id}`);
  assert.equal((await daemon.runtime.mcp.list()).length, 1);
  assert.deepEqual(methods, []);
  const path = '/v1/settings/mcp/linked-service';
  const discovered = await client.request<{ revision: string; test: { status: string } }>(`${path}/test`, 'POST', {});
  assert.equal(discovered.test.status, 'ok');
  await client.request(`${path}/enable`, 'POST', { revision: discovered.revision, tools: ['status'] });
  await client.request('/v1/settings/mcp/project', 'PUT', { workspace: f.workspace, tools: [{ id: 'linked-service', tool: 'status' }] });
  const task = await daemon.runtime.create('Use the selected MCP status tool.', f.workspace);
  await until(() => daemon.runtime.status(task.id), state => state.status === 'completed');
  assert.equal(methods.filter(method => method === 'tools/call').length, 1);
  assert.deepEqual((await daemon.runtime.status(id)).mcpPins, []);
  await terminal.handle('/new Set an empty project MCP scope.');
  const scopeChat = terminal.taskId!;
  await until(() => daemon.runtime.status(scopeChat), state => state.status === 'answered');
  const [scope] = await daemon.runtime.mcpSettingsProposals(scopeChat);
  assert(scope && 'tools' in scope);
  assert.deepEqual(scope.previous, [{ id: 'linked-service', tool: 'status' }]);
  assert.deepEqual(scope.effective, []);
  await terminal.handle('/mcp-proposals');
  assert(output.some(text => text.includes('linked-service/status') && text.includes('空名单')));
  await terminal.handle(`/apply-mcp ${scope.id}`);
  assert.deepEqual(await daemon.runtime.mcp.projectTools(f.workspace), []);
  assert.deepEqual((await daemon.runtime.status(task.id)).mcpPins?.[0]?.tools, ['status']);
  assert.equal(methods.filter(method => method === 'tools/call').length, 1);
  const remote = await daemon.runtime.create('Remote test', f.workspace, [], { chat: true, remote: true });
  await until(() => daemon.runtime.status(remote.id), state => state.status === 'answered');
  await assert.rejects(daemon.runtime.mcpConnectionProposals(remote.id), /no MCP proposals/i);
});

test('a project tool proposal applies only its tested selection and retains later manual scope', async t => {
  const data = await mkdtemp(join(tmpdir(), 'kada-mcp-scope-proposal-'));
  const { address, methods, close } = await startMcpProposalService();
  t.after(async () => { await close(); await rm(data, { recursive: true, force: true }); });
  const project = join(data, 'project'), other = join(data, 'other');
  await Promise.all([mkdir(project), mkdir(other)]);
  const mcp = new McpTools(data);
  await mcp.configure({ id: 'scope-fixture', transport: 'http', url: address });
  const checked = await mcp.test('scope-fixture');
  await mcp.enable('scope-fixture', ['status', 'unselected'], checked.revision);
  const status = { id: 'scope-fixture', tool: 'status' }, otherTool = { id: 'scope-fixture', tool: 'unselected' };
  await mcp.setProjectTools(project, [status]);
  const original = await mcp.pins(project);
  const before = methods.length;
  const proposal = await mcp.proposeProjectTools(project, 'source', '61', [otherTool]);
  assert.deepEqual(proposal.previous, [status]);
  assert.equal(proposal.state, 'pending');
  assert.deepEqual(await mcp.projectTools(project), [status]);
  await assert.rejects(mcp.decideProjectToolProposal(other, 'source', '61', 'apply'), /not found/i);
  await mcp.setProjectTools(project, []);
  await assert.rejects(mcp.decideProjectToolProposal(project, 'source', '61', 'apply'), /scope.*changed/i);
  await mcp.setProjectTools(project, [status]);
  const draft = await mcp.proposeProjectTools(project, 'source', '62', [otherTool]);
  const approved = await mcp.decideProjectToolProposal(project, 'source', draft.id, 'apply');
  assert.equal(approved.state, 'applied');
  assert.deepEqual((await mcp.pins(project))[0]?.tools, ['unselected']);
  assert.deepEqual(original[0]?.tools, ['status']);
  assert.deepEqual((await mcp.pins(other))[0]?.tools, ['status', 'unselected']);
  await mcp.setProjectTools(project, [status]);
  const reopened = new McpTools(data);
  assert.deepEqual(await reopened.decideProjectToolProposal(project, 'source', '62', 'apply'), approved);
  assert.deepEqual(await reopened.projectTools(project), [status]);
  const disable = await reopened.proposeProjectTools(project, 'source', '63', [otherTool]);
  await reopened.disable('scope-fixture');
  await assert.rejects(reopened.decideProjectToolProposal(project, 'source', disable.id, 'apply'), /scope.*changed/i);
  await reopened.enable('scope-fixture', ['status', 'unselected'], checked.revision);
  const inherited = await reopened.proposeProjectTools(project, 'source', '64', null);
  assert.deepEqual(inherited.effective, [status, otherTool]);
  await reopened.decideProjectToolProposal(project, 'source', inherited.id, 'apply');
  assert.equal(await reopened.projectTools(project), null);
  assert.equal(methods.length, before);
});
