import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { McpTools, type McpDefinition } from '../src/mcp-tools.js';
import { serve } from '../src/server.js';
import { createClient } from '../src/client.js';
import { fauxAssistantMessage, fauxToolCall, getCurrentTools } from '@earendil-works/pi-ai';
import { scriptedFixture, until } from './helpers.js';

const fakeServer = `
  const input = require('node:readline').createInterface({ input: process.stdin });
  input.on('line', (line) => {
    const request = JSON.parse(line);
    if (request.id === undefined) return;
    const results = {
      'initialize': { protocolVersion: request.params?.protocolVersion, serverInfo: {name:'kada-fixture',version:'1'}, capabilities: {tools:{}} },
      'tools/list': { tools: [
        { name: 'echo', description: 'Echo text', inputSchema: { type:'object', properties:{text:{type:'string'}}, required:['text'] } },
        { name: 'pause', inputSchema: { type:'object' } },
      ] },
      'tools/call': { content: [{type:'text',text:request.params?.arguments?.text??''}] },
    };
    if (request.method === 'tools/call' && request.params.name === 'pause') return;
    console.log(JSON.stringify({jsonrpc:'2.0',id:request.id,result:results[request.method]}));
  });
`;

const definition: McpDefinition = { id: 'fixture', transport: 'stdio', command: process.execPath, args: ['-e', fakeServer] };

test('the local MCP connection page manages the same tested definitions and global controls as the CLI', async t => {
  const fixture = await scriptedFixture(() => fauxAssistantMessage('Ready.'));
  await fixture.runtime.close();
  const socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const config = { ...fixture.settings, port };
  const server = await serve(config, { models: fixture.models });
  t.after(async () => { await server.close(); await fixture.close(); });
  const client = createClient(config);
  const { url } = await client.request<{ url: string }>('/v1/settings/mcp/connections-link', 'POST', {});
  assert.match(await (await fetch(url)).text(), /MCP 连接/);
  const location = new URL(url);
  assert.equal((await fetch(location.origin + '/v1/settings/mcp/connections-link', { method: 'POST' })).status, 401);
  const call = (route: string, method: string, token?: string, input?: unknown) => fetch(location.origin + location.pathname + '/' + route, {
    method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(input !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(input !== undefined ? { body: JSON.stringify(input) } : {}),
  });
  assert.equal((await call('connections', 'POST', undefined, definition)).status, 401);
  const projectLink = await client.request<{ url: string }>('/v1/settings/mcp/link', 'POST', { workspace: fixture.workspace });
  assert.equal((await call('session', 'POST', undefined, { ticket: new URL(projectLink.url).hash.slice(1) })).status, 401);
  const ticket = location.hash.slice(1);
  const { token } = await (await call('session', 'POST', undefined, { ticket })).json();
  assert.equal((await call('session', 'POST', undefined, { ticket })).status, 401);
  assert.equal((await fetch(location.origin + location.pathname + '/state', {
    headers: { Authorization: 'Bearer ' + token, Origin: 'https://example.test' },
  })).status, 403);
  assert.equal((await call('connections', 'POST', token, definition)).status, 201);
  const initial = await (await call('state', 'GET', token)).json();
  assert.equal(initial.connections[0].id, 'fixture');
  assert(!Object.hasOwn(initial.connections[0], 'definition'));
  const tested = await (await call('connections/fixture/test', 'POST', token)).json();
  assert.equal(tested.test.status, 'ok');
  assert.equal((await call('connections/fixture/enable', 'POST', token, { revision: 'old', tools: ['echo'] })).status, 400);
  assert.equal((await call('connections/fixture/enable', 'POST', token, { revision: tested.revision, tools: ['echo'] })).status, 200);
  assert.equal((await call('connections/fixture/approval', 'POST', token, { revision: tested.revision, tools: ['echo'] })).status, 200);
  assert.deepEqual((await server.runtime.mcp.pins())[0]?.approvalTools, ['echo']);
  assert.equal((await call('connections/fixture/disable', 'POST', token)).status, 200);
  assert.deepEqual(await server.runtime.mcp.pins(), []);
});

test('the local MCP page edits only the linked project and distinguishes inheritance from an empty allowlist', async t => {
  const fixture = await scriptedFixture(() => fauxAssistantMessage('Ready.'));
  await fixture.runtime.close();
  const socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const config = { ...fixture.settings, port };
  const server = await serve(config, { models: fixture.models });
  t.after(async () => { await server.close(); await fixture.close(); });
  await server.runtime.mcp.configure(definition);
  const tested = await server.runtime.mcp.test('fixture');
  await server.runtime.mcp.enable('fixture', ['echo', 'pause'], tested.revision);
  const other = join(fixture.directory, 'other-project');
  await mkdir(other);
  const client = createClient(config);
  const { url } = await client.request<{ url: string }>('/v1/settings/mcp/link', 'POST', { workspace: fixture.workspace });
  assert.match(await (await fetch(url)).text(), /项目 MCP 工具/);
  const location = new URL(url);
  const call = (route: string, method: string, token?: string, input?: unknown) => fetch(location.origin + location.pathname + '/' + route, {
    method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(input !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(input !== undefined ? { body: JSON.stringify(input) } : {}),
  });
  assert.equal((await call('state', 'GET')).status, 401);
  const { token } = await (await call('session', 'POST', undefined, { ticket: location.hash.slice(1) })).json();
  assert.equal((await call('session', 'POST', undefined, { ticket: location.hash.slice(1) })).status, 401);
  const original = await (await call('state', 'GET', token)).json();
  assert.equal(original.tools, null);
  assert.deepEqual(original.connections, [{ id: 'fixture', tools: ['echo', 'pause'] }]);
  assert.equal((await call('tools', 'PUT', token, { workspace: other, tools: [] })).status, 400);
  const echo = [{ id: 'fixture', tool: 'echo' }];
  assert.equal((await call('tools', 'PUT', token, { tools: echo })).status, 200);
  assert.deepEqual(await server.runtime.mcp.projectTools(fixture.workspace), echo);
  assert.equal(await server.runtime.mcp.projectTools(other), null);
  assert.equal((await call('tools', 'PUT', token, { tools: [{ id: 'fixture', tool: 'absent' }] })).status, 400);
  assert.equal((await call('tools', 'PUT', token, { tools: [] })).status, 200);
  assert.deepEqual(await server.runtime.mcp.pins(fixture.workspace), []);
  assert.equal((await call('tools', 'PUT', token, { tools: null })).status, 200);
  assert.equal(await server.runtime.mcp.projectTools(fixture.workspace), null);

  const addOffice = [
    "require('node:readline').createInterface({input:process.stdin}).on('line',line=>{",
    "const request=JSON.parse(line);if(request.id===undefined)return;",
    "const tools=['search_gmail_messages','get_gmail_message_content','list-events','list-calendars'].map(name=>({name,inputSchema:{type:'object'},annotations:{readOnlyHint:true}}));",
    "let result={initialize:{protocolVersion:request.params?.protocolVersion,serverInfo:{name:'office-fixture',version:'1'},capabilities:{tools:{}}},'tools/list':{tools}}[request.method];",
    "if(request.method==='tools/call') { const valid=request.params.name==='list-calendars' && request.params.arguments.account==='work';",
    "result={isError:!valid,content:[{type:'text',text:JSON.stringify({calendars:[{id:'team-calendar',summary:'Team calendar',timeZone:'UTC'},{id:'deleted',deleted:true}]})}]};}",
    "console.log(JSON.stringify({jsonrpc:'2.0',id:request.id,result}));});",
  ].join('\n');
  await server.runtime.mcp.configure({id:'office',transport:'stdio',command:process.execPath,args:['-e',addOffice]});
  const {revision} = await server.runtime.mcp.test('office');
  await server.runtime.mcp.enable('office',['search_gmail_messages','get_gmail_message_content','list-events','list-calendars'],revision);
  assert.equal((await call('bindings','GET')).status,401);
  const available = await (await call('bindings','GET',token)).json();
  assert.deepEqual(available,{
    gmail:{source:null,connections:[{id:'office',revision}]},
    calendar:{source:null,connections:[{id:'office',revision,canListCalendars:true}]},
  });
  const discovery = {id:'office',revision,account:'work'};
  assert.equal((await call('calendar-options','POST',undefined,discovery)).status,401);
  assert.equal((await call('calendar-options','POST',token,{...discovery,workspace:other})).status,400);
  assert.deepEqual(await (await call('calendar-options','POST',token,discovery)).json(),
    {calendars:[{id:'team-calendar',title:'Team calendar',timeZone:'UTC'}]});
  const mail = {id:'office',revision,email:'project@example.invalid',allowAssistant:true};
  const calendar = {id:'office',revision,account:'work',calendarId:'primary',timeZone:'UTC',allowAssistant:true};
  assert.equal((await call('gmail-source','PUT',token,{...mail,workspace:other})).status,400);
  assert.equal((await call('gmail-source','PUT',token,mail)).status,200);
  assert.equal((await call('calendar-source','PUT',token,calendar)).status,200);
  const saved = await (await call('bindings','GET',token)).json();
  assert.deepEqual(saved.gmail.source,mail);
  assert.deepEqual(saved.calendar.source,calendar);
  assert.equal((await server.runtime.gmail.source(other)).source,null);
  assert.equal((await server.runtime.calendars.source(other)).source,null);
  assert.equal((await call('tools','PUT',token,{tools:[]})).status,200);
  const revoked = await (await call('bindings','GET',token)).json();
  assert.deepEqual(revoked.gmail,{source:mail,connections:[]});
  assert.equal((await call('calendar-options','POST',token,discovery)).status,409);
  assert.equal((await call('gmail-source','DELETE',token)).status,200);
  assert.equal((await server.runtime.gmail.source(fixture.workspace)).source,null);
  assert.deepEqual((await server.runtime.calendars.source(fixture.workspace)).source,calendar);
});

test('C05 MCP discovery alone grants no tools, allowlist gates calls and cancel closes them', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kada-mcp-'));
  const manager = new McpTools(dir);
  try {
    await manager.configure(definition);
    assert.deepEqual(await manager.pins(), []);
    await assert.rejects(manager.enable('fixture', ['echo']), /test/i);
    const status = await manager.test('fixture');
    assert.equal(status.test?.status, 'ok');
    assert.deepEqual(status.test?.tools?.map(tool => tool.name), ['echo', 'pause']);
    await assert.rejects(manager.enable('fixture', ['other'], status.revision), /discover/i);
    await manager.enable('fixture', ['echo'], status.revision);
    const pins = await manager.pins();
    const [echo] = await manager.tools(pins);
    const call = (tool: typeof echo, args: Record<string, unknown>, abortSignal?: AbortSignal) => tool.execute(
      args, {} as Parameters<typeof tool.execute>[1], { abortSignal } as Parameters<typeof tool.execute>[2],
    );
    assert.deepEqual((await call(echo, { text: 'hello' })).output, [{ type: 'text', text: 'hello' }]);
    assert.equal((await manager.tools(pins)).length, 1);
    await manager.enable('fixture', ['pause'], status.revision);
    await assert.rejects(call(echo, { text: 'old' }), /enabled|allowed/i);
    const [pause] = await manager.tools();
    const controller = new AbortController();
    const inFlight = call(pause, {}, controller.signal);
    setTimeout(() => controller.abort(), 250);
    await assert.rejects(inFlight, /abort|cancel/i);
    await manager.disable('fixture');
    assert.deepEqual(await manager.tools(), []);
  } finally {
    await manager.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('C06 MCP testing and tool pins require the current configuration revision', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kada-mcp-'));
  const manager = new McpTools(dir);
  try {
    await manager.configure(definition);
    const tested = await manager.test('fixture');
    await manager.enable('fixture', ['echo'], tested.revision);
    const pins = await manager.pins();
    const next = await manager.configure({ ...definition, args: ['-e', `${fakeServer}\n`] });
    assert.notEqual(next.revision, tested.revision);
    assert.equal(next.enabled, false);
    assert.equal(next.test, undefined);
    assert.deepEqual(await manager.pins(), []);
    await assert.rejects(manager.enable('fixture', ['echo'], tested.revision), /changed/i);
    const [saved] = await manager.tools(pins);
    assert.ok(saved);
    assert.deepEqual(saved.parameters, pins[0].discovery?.[0]?.inputSchema);
    await assert.rejects(saved.execute(
      { text: 'stale' }, {} as Parameters<typeof saved.execute>[1], {} as Parameters<typeof saved.execute>[2],
    ), /changed/i);
  } finally {
    await manager.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('project MCP defaults narrow the global allowlist for new tasks and survive restart', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'kada-mcp-project-'));
  const first = new McpTools(dataDir);
  const second = new McpTools(dataDir);
  t.after(async () => {
    await Promise.all([first.close(), second.close()]);
    await rm(dataDir, { recursive: true, force: true });
  });
  const project = join(dataDir, 'project');
  const child = join(project, 'subdirectory');
  const other = join(dataDir, 'other');
  await Promise.all([mkdir(child, { recursive: true }), mkdir(other)]);
  await writeFile(join(project, '.kada-project'), '');
  await first.configure(definition);
  const { revision } = await first.test(definition.id);
  await first.enable(definition.id, ['echo', 'pause'], revision);

  const echo = { id: definition.id, tool: 'echo' };
  const pause = { id: definition.id, tool: 'pause' };
  await assert.rejects(first.setProjectTools(project, [{ id: definition.id, tool: 'unknown' }]), /enabled/i);
  await first.setProjectTools(child, [echo]);
  await first.setProjectTools(other, []);
  const pinned = await second.pins(project);
  assert.deepEqual(pinned.flatMap(pin => pin.tools), ['echo']);
  assert.deepEqual(pinned.flatMap(pin => pin.discovery?.map(tool => tool.name)), ['echo']);
  assert.deepEqual(await second.pins(other), []);
  assert.deepEqual((await second.pins()).flatMap(pin => pin.tools), ['echo', 'pause']);
  assert.deepEqual(await second.projectTools(child), [echo]);

  await first.setProjectTools(project, [pause]);
  assert.deepEqual((await second.pins(child)).flatMap(pin => pin.tools), ['pause']);
  assert.equal((await second.tools(pinned)).length, 1);
  await first.disable(definition.id);
  assert.deepEqual(await second.pins(child), []);
  assert.deepEqual(await second.projectTools(child), [pause]);
  await first.setProjectTools(project, null);
  assert.equal(await second.projectTools(child), null);
});

test('authenticated project MCP settings pin the tools Pi actually sees after reopening a task', async () => {
  const f = await scriptedFixture(({ messages }) => {
    const summary = getCurrentTools(messages).filter(tool => tool.name.startsWith('mcp_fixture_'))
      .map(tool => tool.name.split('_')[2]).sort().join(',') || 'no MCP tools';
    return fauxAssistantMessage(fauxToolCall('task_submit', { summary, artifacts: [] }), { stopReason: 'toolUse' });
  });
  const workspace = f.workspace;
  const portProbe = createServer().listen(0, '127.0.0.1');
  await once(portProbe, 'listening');
  const settings = { ...f.settings, port: (portProbe.address() as { port: number }).port };
  portProbe.close();
  await once(portProbe, 'close');
  const path = '/v1/settings/mcp/project';
  let server = await serve(settings, { models: f.models });
  const client = createClient(settings);
  const create = (project?: string) => client.request<{ id: string }>('/v1/tasks', 'POST', {
    objective: 'List the available integrations', confirmed: true, workspace: project,
  });
  const answer = (id: string) => until(
    () => server.runtime.status(id), status => status.status === 'completed',
  );
  try {
    const manager = server.runtime.mcp;
    await manager.configure(definition);
    const { revision } = await manager.test(definition.id);
    await manager.enable(definition.id, ['echo', 'pause'], revision);
    assert.deepEqual(await client.request(path, 'PUT', { workspace, tools: [{ id: 'fixture', tool: 'echo' }] }), {
      tools: [{ id: 'fixture', tool: 'echo' }],
    });
    assert.deepEqual(await client.request(path + '?workspace=' + encodeURIComponent(workspace)), {
      tools: [{ id: 'fixture', tool: 'echo' }],
    });
    const original = await create(workspace);
    assert.equal((await answer(original.id)).goal?.candidate?.summary, 'echo');
    await client.request(path, 'PUT', { workspace, tools: [] });
    await server.close();
    server = await serve(settings, { models: f.models });
    const scoped = await create(workspace);
    assert.equal((await answer(scoped.id)).goal?.candidate?.summary, 'no MCP tools');
    const global = await create();
    assert.equal((await answer(global.id)).goal?.candidate?.summary, 'echo,pause');
    assert.deepEqual((await server.runtime.metadata(original.id)).mcpPins?.flatMap(pin => pin.tools), ['echo']);
  } finally { await server.close(); await f.close(); }
});

test('MCP discovery drops a server response that reflects a configured credential', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kada-mcp-secret-'));
  const manager = new McpTools(dir);
  const envName = 'KADA_MCP_TEST_REFLECTION';
  const value = 'fixture-auth-value';
  const previous = process.env[envName];
  process.env[envName] = value;
  try {
    await manager.configure({
      ...definition,
      transport: 'stdio',
      env: { FIXTURE_AUTH: envName },
      args: ['-e', fakeServer.replace("'Echo text'", "'Echo ' + process.env.FIXTURE_AUTH")],
    });
    const tested = await manager.test('fixture');
    assert.equal(tested.test?.status, 'failed');
    assert.doesNotMatch(JSON.stringify(tested), new RegExp(value));
    assert.doesNotMatch(await readFile(join(dir, 'mcp-connections.json'), 'utf8'), new RegExp(value));
  } finally {
    if (previous === undefined) delete process.env[envName];
    else process.env[envName] = previous;
    await manager.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('MCP call results keep a reflected credential out of the Pi tool output', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kada-mcp-call-secret-'));
  const manager = new McpTools(dir);
  const envName = 'KADA_MCP_TEST_TOOL_REFLECTION';
  const credential = 'fixture-private-call-value';
  const previous = process.env[envName];
  process.env[envName] = credential;
  try {
    await manager.configure({
      ...definition,
      transport: 'stdio',
      env: { FIXTURE_AUTH: envName },
      args: ['-e', fakeServer.replace(
        "text:request.params?.arguments?.text??''",
        "text:'Reflected: ' + process.env.FIXTURE_AUTH",
      )],
    });
    const tested = await manager.test('fixture');
    assert.equal(tested.test?.status, 'ok');
    await manager.enable('fixture', ['echo'], tested.revision);
    const [tool] = await manager.tools();
    assert.ok(tool);
    const result = await tool.execute(
      { text: 'synthetic input' }, {} as Parameters<typeof tool.execute>[1], {} as Parameters<typeof tool.execute>[2],
    );
    assert.equal(result.isError, true);
    assert.equal(JSON.stringify(result).includes(credential), false);
    assert.deepEqual(result.output, [{ type: 'text', text: 'MCP tool response contained a configured credential and was withheld.' }]);
  } finally {
    if (previous === undefined) delete process.env[envName];
    else process.env[envName] = previous;
    await manager.close();
    await rm(dir, { recursive: true, force: true });
  }
});
