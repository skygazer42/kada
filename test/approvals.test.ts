import assert from 'node:assert/strict';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fauxAssistantMessage, fauxToolCall, getCurrentTools } from '@earendil-works/pi-ai';
import { LocalRuntime } from '../src/runtime.js';
import { scriptedFixture, until } from './helpers.js';
import { Harness, createRegistry } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { ApprovalDoc } from '../src/approvals.js';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { serve } from '../src/server.js';
import { createClient } from '../src/client.js';
import { ChatSession } from '../src/chat.js';

const server = `const fs = require('node:fs');
const input = require('node:readline').createInterface({input:process.stdin});
input.on('line', line => { const r = JSON.parse(line); if (r.id === undefined) return;
let result;
if (r.method === 'initialize') result = {protocolVersion:r.params.protocolVersion,serverInfo:{name:'approval-fixture',version:'1'},capabilities:{tools:{}}};
if (r.method === 'tools/list') result = {tools:[{name:'append',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']}}]};
if (r.method === 'tools/call') { fs.appendFileSync(process.argv[1], r.params.arguments.text + '\\n'); result={content:[{type:'text',text:'Appended once'}]}; }
console.log(JSON.stringify({jsonrpc:'2.0',id:r.id,result})); });`;

for (const decision of ['allow', 'deny'] as const) test(`one MCP action receives ${decision} with its exact parameters and survives duplicate decisions`, async () => {
  let requested = false;
  const f = await scriptedFixture(context => {
    const tool = getCurrentTools(context.messages).find(tool => tool.name.startsWith('mcp_counter_'));
    if (!requested) {
      requested = true;
      return fauxAssistantMessage(fauxToolCall(tool!.name, { text: 'approved-value' }), { stopReason: 'toolUse' });
    }
    return fauxAssistantMessage(fauxToolCall('task_submit', { summary: 'Reviewed action outcome', artifacts: [] }), { stopReason: 'toolUse' });
  });
  let reopened: LocalRuntime | undefined;
  const effects = join(f.directory, 'effects.txt');
  try {
    await f.runtime.mcp.configure({ id: 'counter', transport: 'stdio', command: process.execPath, args: ['-e', server, effects] });
    const checked = await f.runtime.mcp.test('counter');
    await f.runtime.mcp.enable('counter', ['append'], checked.revision);
    await f.runtime.mcp.setApproval('counter', ['append'], checked.revision);
    const task = await f.runtime.create('Run the selected MCP action once', f.workspace);
    const waiting = await until(() => f.runtime.status(task.id), status => status.status === 'waiting_user');
    const [approval] = waiting.approvals;
    assert.equal(approval.status, 'pending');
    assert.deepEqual(approval.arguments, { text: 'approved-value' });
    await assert.rejects(readFile(effects), { code: 'ENOENT' });
    await f.runtime.close();
    reopened = new LocalRuntime(f.settings, { models: f.models });
    await reopened.recover();
    await assert.rejects(reopened.decideApproval(task.id, approval.id, decision, '0'.repeat(64)), { status: 409 });
    await reopened.decideApproval(task.id, approval.id, decision, approval.digest);
    await reopened.decideApproval(task.id, approval.id, decision, approval.digest);
    const done = await until(() => reopened!.status(task.id), status => status.status === 'completed');
    assert.equal(done.approvals[0].status, decision === 'allow' ? 'completed' : 'denied');
    if (decision === 'allow') assert.equal(await readFile(effects, 'utf8'), 'approved-value\n');
    else await assert.rejects(readFile(effects), { code: 'ENOENT' });
  } finally { await reopened?.close(); await f.close(); }
});

test('the owner reviews an action in terminal and decides through the authenticated API', async () => {
  let requested = false;
  const f = await scriptedFixture(context => {
    if (!requested) {
      requested = true;
      const tool = getCurrentTools(context.messages).find(tool => tool.name.startsWith('mcp_counter_'))!;
      return fauxAssistantMessage(fauxToolCall(tool.name, { text: 'terminal-value' }), { stopReason: 'toolUse' });
    }
    return fauxAssistantMessage(fauxToolCall('task_submit', { summary: 'Owner decision handled', artifacts: [] }), { stopReason: 'toolUse' });
  });
  const portProbe = createServer().listen(0, '127.0.0.1');
  await once(portProbe, 'listening');
  const settings = { ...f.settings, port: (portProbe.address() as { port: number }).port };
  portProbe.close(); await once(portProbe, 'close');
  const daemon = await serve(settings, { models: f.models });
  const client = createClient(settings);
  const output: string[] = [];
  const effects = join(f.directory, 'effects.txt');
  try {
    await daemon.runtime.mcp.configure({ id: 'counter', transport: 'stdio', command: process.execPath, args: ['-e', server, effects] });
    const checked = await daemon.runtime.mcp.test('counter');
    await daemon.runtime.mcp.enable('counter', ['append'], checked.revision);
    await client.request('/v1/settings/mcp/counter/approval', 'POST', { revision: checked.revision, tools: ['append'] });
    const task = await daemon.runtime.create('Review a local action', f.workspace);
    const waiting = await until(() => daemon.runtime.status(task.id), status => status.status === 'waiting_user' && status.tasks.length === 0);
    const approval = waiting.approvals[0]!;
    const path = `/v1/tasks/${task.id}/approvals`;
    const forbidden = await fetch(`http://127.0.0.1:${settings.port}${path}/${approval.id}/allow`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ digest: approval.digest }),
    });
    assert.equal(forbidden.status, 401);
    const terminal = new ChatSession(client, event => output.push(event.text));
    await terminal.attach(task.id);
    await terminal.handle('/approvals');
    assert(output.join('\n').includes('terminal-value'));
    await terminal.handle('/allow ' + approval.id);
    const done = await until(() => daemon.runtime.status(task.id), status => status.status === 'completed');
    assert.equal(done.approvals[0]!.status, 'completed');
    assert.equal(await readFile(effects, 'utf8'), 'terminal-value\n');
  } finally { await daemon.close(); await f.close(); }
});

test('a shared local approval is bound to one action and one device pairing', async () => {
  const actionText = 'shared-value ' + 'Bearer ' + 'synthetic-header-value';
  const f = await scriptedFixture(context => {
    const tool = getCurrentTools(context.messages).find(tool => tool.name.startsWith('mcp_counter_'))!;
    if (context.messages.some(message => message.role === 'user' && (
      typeof message.content === 'string' ? message.content.startsWith('MCP action approval') :
        message.content.some(block => block.type === 'text' && block.text.startsWith('MCP action approval'))
    ))) {
      return fauxAssistantMessage(fauxToolCall('task_submit', { summary: 'Action handled', artifacts: [] }), { stopReason: 'toolUse' });
    }
    return fauxAssistantMessage(fauxToolCall(tool.name, { text: actionText }), { stopReason: 'toolUse' });
  }, { maxDurationMs: 60_000 });
  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const settings = { ...f.settings, port: (probe.address() as { port: number }).port };
  probe.close(); await once(probe, 'close');
  const open = () => serve(settings, { models: f.models });
  let daemon = await open();
  const client = createClient(settings);
  const effects = join(f.directory, 'shared-effects.txt');
  const pair = (deviceId: string) => client.request<{token: string}>('/v1/remote/devices', 'POST', { accountId: 'owner', deviceId });
  const phone = (token: string, path: string, input?: object) => fetch('http://127.0.0.1:' + settings.port + '/remote/api/action-approvals' + path, {
    method: input ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: input ? JSON.stringify(input) : undefined,
  });
  try {
    await daemon.runtime.mcp.configure({ id: 'counter', transport: 'stdio', command: process.execPath, args: ['-e', server, effects] });
    const checked = await daemon.runtime.mcp.test('counter');
    await daemon.runtime.mcp.enable('counter', ['append'], checked.revision);
    await daemon.runtime.mcp.setApproval('counter', ['append'], checked.revision);
    const task = await daemon.runtime.create('Share one local action', f.workspace);
    const waiting = await until(() => daemon.runtime.status(task.id), state => state.status === 'waiting_user' && state.tasks.length === 0);
    const action = waiting.approvals[0]!;
    const endpoint = '/' + task.id + '/' + action.id;
    const admin = '/v1/tasks/' + task.id + '/approvals/' + action.id + '/share';
    const decision = { decision: 'allow', digest: action.digest };
    const { token: original } = await pair('phone');
    const { token: tablet } = await pair('tablet');
    assert.deepEqual(await (await phone(original, '')).json(), []);
    assert.equal((await phone(original, endpoint, decision)).status, 404);
    await client.request(admin, 'POST', { accountId: 'owner', deviceId: 'phone', digest: action.digest });
    await daemon.close();
    daemon = await open();
    assert.deepEqual(await (await phone(tablet, '')).json(), []);
    assert.equal((await phone(tablet, endpoint, decision)).status, 404);
    const [preview] = await (await phone(original, '')).json();
    assert.deepEqual(Object.keys(preview).sort(), ['approvalId', 'argumentsPreview', 'connection', 'digest', 'expiresAt', 'status', 'taskId', 'tool']);
    assert.equal(preview.digest, action.digest);
    assert.equal(JSON.parse(preview.argumentsPreview).text, 'shared-value [credential withheld]');
    assert.equal((await phone(original, endpoint, { ...decision, digest: '0'.repeat(64) })).status, 409);
    const recipient = { accountId: 'owner', deviceId: 'phone', digest: action.digest };
    assert.deepEqual(await client.request(admin.replace(/\/share$/, '/unshare'), 'POST', recipient), { shared: false });
    assert.deepEqual(await (await phone(original, '')).json(), []);
    assert.equal((await phone(original, endpoint, decision)).status, 404);
    await client.request(admin, 'POST', recipient);
    await client.request('/v1/remote/devices/owner/phone', 'DELETE');
    const { token: replacement } = await pair('phone');
    assert.equal((await phone(original, endpoint, decision)).status, 401);
    assert.equal((await phone(replacement, endpoint, decision)).status, 404);
    await assert.rejects(readFile(effects), { code: 'ENOENT' });
    await client.request(admin, 'POST', { accountId: 'owner', deviceId: 'phone', digest: action.digest });
    const accepted = await phone(replacement, endpoint, decision);
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), { id: action.id, decision: 'allow' });
    const replay = await phone(replacement, endpoint, decision);
    assert.equal(replay.status, 200);
    await until(() => daemon.runtime.status(task.id), state => state.status === 'completed');
    assert.equal(await readFile(effects, 'utf8'), actionText + '\n');
    assert.deepEqual(await (await phone(replacement, '')).json(), []);
  } finally { await daemon.close(); await f.close(); }
});

for (const change of ['revision', 'expired', 'revoked', 'connection'] as const) test(`an approval cannot execute after its ${change} changes`, async () => {
  let requested = false;
  const f = await scriptedFixture(context => {
    if (!requested) {
      requested = true;
      const tool = getCurrentTools(context.messages).find(tool => tool.name.startsWith('mcp_counter_'))!;
      return fauxAssistantMessage(fauxToolCall(tool.name, { text: 'stale-value' }), { stopReason: 'toolUse' });
    }
    return fauxAssistantMessage(fauxToolCall('task_submit', { summary: 'Adjusted goal', artifacts: [] }), { stopReason: 'toolUse' });
  });
  const effects = join(f.directory, 'effects.txt');
  let reopened: LocalRuntime | undefined;
  try {
    const definition = { id: 'counter', transport: 'stdio' as const, command: process.execPath, args: ['-e', server, effects] };
    await f.runtime.mcp.configure(definition);
    const checked = await f.runtime.mcp.test('counter');
    await f.runtime.mcp.enable('counter', ['append'], checked.revision);
    await f.runtime.mcp.setApproval('counter', ['append'], checked.revision);
    const task = await f.runtime.create('Approve one local fixture action', f.workspace);
    const [approval] = (await until(() => f.runtime.status(task.id), status => status.status === 'waiting_user')).approvals;
    if (change === 'revision') await f.runtime.followUp(task.id, 'Adjust this goal before proceeding');
    if (change === 'revoked') await f.runtime.mcp.disable('counter');
    if (change === 'connection') await f.runtime.mcp.configure({ ...definition, args: [...definition.args, 'changed'] });
    if (change === 'expired') {
      await f.runtime.close();
      const harness = await Harness.open(await openNodeSqliteStorage(join(f.directory, 'tasks', task.id, 'session.sqlite')), { models: f.models, registry: createRegistry() }, ctx);
      await harness.commit(async tx => { (await tx.doc(ApprovalDoc)).requests[approval.id].expiresAt = Date.now() - 1; }, ctx);
      await harness.close(ctx);
      reopened = new LocalRuntime(f.settings, { models: f.models });
      await reopened.recover();
    }
    await assert.rejects((reopened ?? f.runtime).decideApproval(task.id, approval.id, 'allow', approval.digest));
    if (change === 'expired') {
      await reopened!.decideApproval(task.id, approval.id, 'deny', approval.digest);
      const done = await until(() => reopened!.status(task.id), status => status.status === 'completed');
      assert.equal(done.approvals[0]!.status, 'denied');
    }
    await assert.rejects(readFile(effects), { code: 'ENOENT' });
  } finally { await reopened?.close(); await f.close(); }
});

test('a mixed tool round cannot stage an approval until the protected call is made by itself', async () => {
  let rounds = 0;
  const f = await scriptedFixture(context => {
    const tool = getCurrentTools(context.messages).find(tool => tool.name.startsWith('mcp_counter_'))!;
    const call = fauxToolCall(tool.name, { text: 'single-round-value' });
    return ++rounds === 1
      ? fauxAssistantMessage([call, fauxToolCall('list_files', {})], { stopReason: 'toolUse' })
      : fauxAssistantMessage(call, { stopReason: 'toolUse' });
  });
  try {
    const effects = join(f.directory, 'effects.txt');
    await f.runtime.mcp.configure({ id: 'counter', transport: 'stdio', command: process.execPath, args: ['-e', server, effects] });
    const checked = await f.runtime.mcp.test('counter');
    await f.runtime.mcp.enable('counter', ['append'], checked.revision);
    await f.runtime.mcp.setApproval('counter', ['append'], checked.revision);
    const task = await f.runtime.create('Request the protected action by itself', f.workspace);
    const waiting = await until(() => f.runtime.status(task.id), status => status.status === 'waiting_user' && status.tasks.length === 0);
    assert.equal(rounds, 2);
    assert.equal(waiting.approvals.length, 1);
    assert(waiting.messages.some(message => message.role === 'toolResult' && message.isError &&
      message.content.some(block => block.type === 'text' && block.text.includes('by itself'))));
    await assert.rejects(readFile(effects), { code: 'ENOENT' });
  } finally { await f.close(); }
});

test('a connection handshake that crosses the task deadline cannot dispatch an approved action', async () => {
  let requested = false;
  const f = await scriptedFixture(context => {
    if (requested) return fauxAssistantMessage('Action stopped.');
    requested = true;
    const tool = getCurrentTools(context.messages).find(tool => tool.name.startsWith('mcp_counter_'))!;
    return fauxAssistantMessage(fauxToolCall(tool.name, { text: 'late-value' }), { stopReason: 'toolUse' });
  });
  const effects = join(f.directory, 'effects.txt');
  const gate = join(f.directory, 'hold-connect');
  const ready = join(f.directory, 'handshake-started');
  const delayed = server.replace("if (r.method === 'initialize') result =", "if (r.method === 'initialize' && fs.existsSync(process.argv[2])) { fs.writeFileSync(process.argv[3], 'ready'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2500); }\nif (r.method === 'initialize') result =");
  try {
    await f.runtime.mcp.configure({ id: 'counter', transport: 'stdio', command: process.execPath, args: ['-e', delayed, effects, gate, ready] });
    const checked = await f.runtime.mcp.test('counter');
    await f.runtime.mcp.enable('counter', ['append'], checked.revision);
    await f.runtime.mcp.setApproval('counter', ['append'], checked.revision);
    const task = await f.runtime.create('Wait for approval before the deadline', f.workspace);
    const [approval] = (await until(() => f.runtime.status(task.id), status => status.status === 'waiting_user' && status.tasks.length === 0)).approvals;
    await f.runtime.close();
    const reopened = new LocalRuntime(f.settings, { models: f.models });
    try {
      // Keep the supervisor idle so the dispatch boundary itself has to enforce the deadline.
      clearInterval(reopened['timer']);
      await writeFile(join(f.directory, 'tasks', task.id, 'task.json'), JSON.stringify({ ...task, deadlineAt: Date.now() + 1800 }));
      await writeFile(gate, 'hold');
      await reopened.decideApproval(task.id, approval.id, 'allow', approval.digest);
      await until(async () => access(ready).then(() => true, () => false), Boolean);
      const result = await until(() => reopened.status(task.id), status => status.approvals[0]?.status === 'expired');
      assert.match(result.approvals[0]!.result!, /before dispatch/);
      await assert.rejects(readFile(effects), { code: 'ENOENT' });
    } finally { await reopened.close(); }
  } finally { await f.close(); }
});
