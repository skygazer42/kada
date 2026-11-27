import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { createClient } from '../src/client.js';
import { LocalRuntime } from '../src/runtime.js';
import { serve } from '../src/server.js';
import { hasTool, scriptedFixture, until } from './helpers.js';

const calendarServer = `
  const fs = require('node:fs');
  const input = require('node:readline').createInterface({ input: process.stdin });
  input.on('line', (line) => {
    const request = JSON.parse(line);
    if (request.id === undefined) return;
    const event = (id, summary, start, end, accountId = 'work') => ({ id, summary, start, end, accountId, description: 'private event notes' });
    const results = {
      initialize: { protocolVersion: request.params?.protocolVersion, serverInfo: {name:'calendar-fixture',version:'1'}, capabilities: {tools:{}} },
      'tools/list': { tools: [
        { name: 'list-events', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
        ...['create-event','update-event','delete-event'].map(name => ({
          name, inputSchema: { type: 'object' }, annotations: { readOnlyHint: false },
        })),
      ] },
      'tools/call': { content: [{ type: 'text', text: JSON.stringify({ events: [
        event('all-day', 'All-day event', { date: '2026-10-31' }, { date: '2026-11-02' }),
        event('timed', 'Afternoon review', { dateTime: '2026-11-10T03:00:00Z' }, { dateTime: '2026-11-10T04:00:00Z' }),
        event('foreign', 'Other account', { date: '2026-11-18' }, { date: '2026-11-19' }, 'private'),
        event('outside', 'Other month', { date: '2026-12-02' }, { date: '2026-12-03' }),
      ] }) }] },
    };
    if (request.method === 'tools/call') {
      const args = request.params.arguments;
      const range = args.timeMin + '/' + args.timeMax;
      if (request.params.name !== 'list-events' || args.account !== 'work' || args.calendarId !== 'primary' ||
          !['2026-11-01T00:00:00/2026-12-01T00:00:00','2026-11-09T00:00:00/2026-11-11T00:00:00'].includes(range) ||
          args.timeZone !== 'America/New_York') {
        results['tools/call'] = { isError: true, content: [{ type: 'text', text: 'Incorrect calendar query' }] };
      }
      if (['create-event','update-event','delete-event'].includes(request.params.name)) {
        fs.appendFileSync(process.argv[1], JSON.stringify({ name:request.params.name,args }) + '\\n');
        results['tools/call'] = { content: [{ type:'text', text:'Confirmed action for ' + args.eventId }] };
      }
    }
    console.log(JSON.stringify({jsonrpc:'2.0',id:request.id,result:results[request.method]}));
  });
`;

test('the workboard reads one bound calendar in the selected month and honors current MCP permission', async t => {
  const f = await scriptedFixture(() => fauxAssistantMessage('No model request is needed.'));
  await f.runtime.close();
  const socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const config = { ...f.settings, port }, origin = `http://127.0.0.1:${port}`;
  let daemon = await serve(config, { models: f.models });
  t.after(async () => { await daemon.close(); await f.close(); });
  const client = createClient(config);
  const mcp = daemon.runtime.mcp;
  await mcp.configure({ id: 'calendar', transport: 'stdio', command: process.execPath, args: ['-e', calendarServer] });
  const tested = await mcp.test('calendar');
  await mcp.enable('calendar', ['list-events'], tested.revision);
  const path = '/v1/work-items/calendar-source?workspace=' + encodeURIComponent(f.workspace);
  await client.request(path, 'PUT', { id: 'calendar', revision: tested.revision, account: 'work', calendarId: 'primary', timeZone: 'America/New_York' });
  await daemon.close();
  daemon = await serve(config, { models: f.models });
  const restored = await client.request<{source: {account: string}}>(path);
  assert.equal(restored.source.account, 'work');
  const foreign = join(f.directory, 'another-project');
  await mkdir(foreign);
  assert.deepEqual(await client.request('/v1/work-items/calendar?workspace=' + encodeURIComponent(foreign) + '&month=2026-11'),
    { configured: false, timeZone: null, events: [] });

  const { url } = await client.request<{ url: string }>('/v1/work-items/board-link', 'POST', { workspace: f.workspace });
  const session = await fetch(origin + '/workboard/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ticket: new URL(url).hash.slice(1) }) });
  const { token } = await session.json();
  const pathInBoard = origin + '/workboard/calendar?month=2026-11';
  assert.equal((await fetch(pathInBoard)).status, 401);
  const calendar = () => fetch(pathInBoard, { headers: { authorization: 'Bearer ' + token } });
  const result = await calendar();
  assert.equal(result.status, 200);
  const view = await result.json();
  assert.deepEqual(view.events.map(({ id, day }: { id: string; day: string }) => [id, day]), [['all-day', '2026-11-01'], ['timed', '2026-11-09']]);
  assert.doesNotMatch(JSON.stringify(view), /private event notes|Other account|Other month/);
  assert.equal(view.timeZone, 'America/New_York');
  const configPath = join(f.directory, 'calendar-config.json');
  await writeFile(configPath, JSON.stringify(config));
  const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'src/cli.ts',
    'work-items', 'calendar', '2026-11', '--workspace', f.workspace, '--config', configPath]);
  assert.deepEqual(JSON.parse(stdout), view);

  await daemon.runtime.mcp.setApproval('calendar', ['list-events'], tested.revision);
  const revoked = await calendar();
  assert.equal(revoked.status, 409);
  assert.match((await revoked.json()).error, /approval|审批/i);
});

test('project calendar mutations dispatch the approved target once and reject a later rebind', async t => {
  const start = '2026-11-09T10:00:00-05:00', end = '2026-11-09T11:00:00-05:00';
  const f = await scriptedFixture(context => {
    const initial = JSON.stringify(context.messages.find(message => message.role === 'user')?.content);
    const operation = initial.includes('Edit original') ? 'update' : initial.includes('Cancel original') ? 'delete' : 'create';
    const tool = 'project_calendar_' + operation;
    const requested = context.messages.some(message => message.role === 'toolResult' && message.toolName === tool);
    if (!hasTool(context, tool)) return fauxAssistantMessage(fauxToolCall('task_submit',{ summary:'Calendar unavailable.', artifacts:[] }),{ stopReason:'toolUse' });
    const args = operation === 'update' ? {eventId:'timed',summary:'Revised review'} : operation === 'delete'
      ? {eventId:'timed',notifyGuests:true} : { summary:'Budget review', start,end, attendees:['guest@example.invalid'] };
    return requested ? fauxAssistantMessage(fauxToolCall('task_submit',{ summary:'Reviewed the action outcome.', artifacts:[] }),{ stopReason:'toolUse' })
      : fauxAssistantMessage(fauxToolCall(tool,args),{ stopReason:'toolUse' });
  },{maxDurationMs:90_000});
  let runtime = f.runtime;
  t.after(async () => { await runtime.close(); await f.close(); });
  const mcp = runtime.mcp;
  const log = join(f.directory,'calendar-writes.jsonl');
  await writeFile(log,'');
  await mcp.configure({ id:'calendar', transport:'stdio', command:process.execPath, args:['-e',calendarServer,log] });
  const { revision } = await mcp.test('calendar');
  const mutations = ['create-event','update-event','delete-event'];
  await mcp.enable('calendar',['list-events',...mutations],revision);
  await mcp.setApproval('calendar',mutations,revision);
  const source = { id:'calendar', revision, account:'work', calendarId:'primary', timeZone:'America/New_York', allowAssistant:true };
  await runtime.calendars.setSource(f.workspace,source);
  const writes = async () => (await readFile(log,'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  const request = async (objective = 'Schedule the budget review and invite the specified guest.') => {
    const run = await runtime.create(objective,f.workspace);
    const status = await until(() => runtime.status(run.id), row => ['waiting_user','completed','failed'].includes(row.status));
    assert.equal(status.status,'waiting_user');
    return { run, approval:status.approvals[0]! };
  };
  const {run,approval} = await request();
  assert.equal(approval.tool,'create-event');
  assert.deepEqual(approval.arguments,{
    account:'work', calendarId:'primary', timeZone:'America/New_York',
    eventId:(approval.arguments as {eventId:string}).eventId, summary:'Budget review', start,end,
    attendees:[{email:'guest@example.invalid'}], sendUpdates:'all',
  });
  assert.match((approval.arguments as {eventId:string}).eventId,/^[0-9a-f]{64}$/);
  assert.deepEqual(await writes(),[]);
  await runtime.close();
  runtime = new LocalRuntime(f.settings,{models:f.models});
  await runtime.recover();
  await runtime.decideApproval(run.id,approval.id,'allow',approval.digest);
  await runtime.decideApproval(run.id,approval.id,'allow',approval.digest);
  await until(() => runtime.status(run.id), row => row.approvals[0]?.status === 'completed');
  assert.deepEqual(await writes(),[{name:'create-event',args:approval.arguments}]);

  const edit = await request('Edit original appointment.');
  assert.equal(edit.approval.tool,'update-event');
  assert.deepEqual(edit.approval.arguments,{account:'work',calendarId:'primary',timeZone:'America/New_York',
    eventId:'timed',summary:'Revised review',modificationScope:'thisEventOnly',sendUpdates:'none'});
  await runtime.decideApproval(edit.run.id,edit.approval.id,'allow',edit.approval.digest);
  await until(() => runtime.status(edit.run.id), row => row.approvals[0]?.status === 'completed');

  const cancellation = await request('Cancel original appointment and notify its guests.');
  assert.equal(cancellation.approval.tool,'delete-event');
  assert.deepEqual(cancellation.approval.arguments,{account:'work',calendarId:'primary',eventId:'timed',sendUpdates:'all'});
  assert.equal((await writes()).length,2);
  await runtime.decideApproval(cancellation.run.id,cancellation.approval.id,'allow',cancellation.approval.digest);
  await until(() => runtime.status(cancellation.run.id), row => row.approvals[0]?.status === 'completed');
  assert.deepEqual((await writes()).slice(1),[{name:'update-event',args:edit.approval.arguments},
    {name:'delete-event',args:cancellation.approval.arguments}]);

  const stale = await request();
  await runtime.calendars.setSource(f.workspace,{ ...source, calendarId:'different' });
  await runtime.decideApproval(stale.run.id,stale.approval.id,'allow',stale.approval.digest);
  await until(() => runtime.status(stale.run.id), row => row.approvals[0]?.status === 'stale');
  assert.equal((await writes()).length,3);
});

test('an opted-in local chat reads the requested days of its project calendar and honors a later revocation', async t => {
  const tool = 'project_calendar_list';
  const f = await scriptedFixture(context => {
    if (!hasTool(context, tool)) return fauxAssistantMessage('Calendar not enabled.');
    const input = context.messages.findLastIndex(message => message.role === 'user');
    const result = context.messages.slice(input + 1).find(message => message.role === 'toolResult' && message.toolName === tool);
    return result ? fauxAssistantMessage(result.isError ? 'Calendar access changed.' : 'Schedule reviewed.')
      : fauxAssistantMessage(fauxToolCall(tool, { from:'2026-11-09', to:'2026-11-11' }), { stopReason:'toolUse' });
  });
  t.after(() => f.close());
  const runtime = f.runtime, mcp = runtime.mcp;
  await mcp.configure({ id:'calendar', transport:'stdio', command:process.execPath, args:['-e',calendarServer] });
  const { revision } = await mcp.test('calendar');
  await mcp.enable('calendar',['list-events'],revision);
  const source = { id:'calendar', revision, account:'work', calendarId:'primary', timeZone:'America/New_York' };
  await runtime.calendars.setSource(f.workspace,source);
  const ask = 'What is on my calendar on November 9 and 10?';
  const wait = (id: string, requestId = 'initial') => until(() => runtime.status(id), row => row.status === 'answered' && row.submission?.requestId === requestId);
  const old = await runtime.create(ask,f.workspace,[],{ chat:true });
  assert.doesNotMatch(JSON.stringify((await wait(old.id)).messages), /"toolName":"project_calendar_list"/);

  await runtime.calendars.setSource(f.workspace,{ ...source, allowAssistant:true });
  const task = await runtime.create(ask,f.workspace,[],{ chat:true });
  const schedule = await wait(task.id);
  assert.equal(schedule.goal,undefined);
  assert.match(JSON.stringify(schedule.messages),/Afternoon review/);
  assert.doesNotMatch(JSON.stringify(schedule.messages),/All-day event|Other account|private event notes/);
  const remote = await runtime.create(ask,f.workspace,[],{ chat:true, remote:true });
  assert.doesNotMatch(JSON.stringify((await wait(remote.id)).messages), /"toolName":"project_calendar_list"/);
  await runtime.followUp(old.id,ask,'old-calendar');
  assert.doesNotMatch(JSON.stringify((await wait(old.id,'user:old-calendar')).messages), /"toolName":"project_calendar_list"/);

  await runtime.calendars.setSource(f.workspace,{ ...source, allowAssistant:false });
  await runtime.followUp(task.id,ask,'revoked-calendar');
  const revoked = await wait(task.id,'user:revoked-calendar');
  assert.match(JSON.stringify(revoked.messages),/The authorized project calendar changed/);
});
