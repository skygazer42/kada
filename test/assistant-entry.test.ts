import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { fauxAssistantMessage, fauxToolCall, fauxProvider } from '@earendil-works/pi-ai';
import { serve } from '../src/server.js';
import { createClient } from '../src/client.js';
import { LocalRuntime } from '../src/runtime.js';
import { artifactTarget } from '../src/artifacts.js';
import { ChatSession } from '../src/chat.js';
import { scriptedFixture, until } from './helpers.js';

async function portNumber() {
  const socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = (socket.address() as {port: number}).port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  return port;
}

test('H01–H04 task handoff filters and event read marks survive reopening the original task', async () => {
  const f = await scriptedFixture(async (context, signal) => {
    const text = JSON.stringify(context.messages);
    if (text.includes('hold-running')) {
      await setTimeout(60_000, undefined, {signal});
      return fauxAssistantMessage('unused');
    }
    return fauxAssistantMessage(fauxToolCall(text.includes('need-input') ? 'task_blocked' : 'task_submit',
      text.includes('need-input') ? {reason:'Missing filename', question:'Which filename?'} : {summary:'Delivered answer', artifacts:[]}), {stopReason:'toolUse'});
  });
  let reopened: LocalRuntime | undefined;
  try {
    const waiting = await f.runtime.create('need-input');
    const delivered = await f.runtime.create('answer-now');
    const running = await f.runtime.create('hold-running');
    await until(() => f.runtime.status(waiting.id), s => s.status === 'waiting_user');
    await until(() => f.runtime.status(delivered.id), s => s.status === 'completed');
    assert.deepEqual((await f.runtime.list('pending')).map(t => t.id), [waiting.id]);
    assert.deepEqual((await f.runtime.list('delivered')).map(t => t.id), [delivered.id]);
    assert((await f.runtime.list('running')).some(t => t.id === running.id));
    const all = await f.runtime.list();
    assert.equal(all[0]!.id, waiting.id);
    assert.match(all[0]!.summary, /Which filename/);
    const events = await f.runtime.notifications();
    assert.equal(events.filter(e => e.taskId === waiting.id).length, 1);
    assert.deepEqual(await f.runtime.notifications(), events);
    await f.runtime.readNotification(events[0]!.id);
    await f.runtime.pause(running.id);
    await f.runtime.close();
    reopened = new LocalRuntime(f.settings, {models:f.models});
    const stored = await reopened.notifications();
    assert.equal(stored.find(e => e.id === events[0]!.id)!.readAt !== null, true);
    const lines: string[] = [];
    const client = {healthy:async()=>true, request:async<T>(path:string):Promise<T> => {
      if (path === '/v1/tasks/' + waiting.id) return await reopened!.status(waiting.id) as T;
      if (path.endsWith('/notifications/read')) return await reopened!.readTaskNotifications(waiting.id) as T;
      throw new Error('Unexpected request ' + path);
    }};
    const terminal = new ChatSession(client, event => lines.push(event.text));
    await terminal.attach(waiting.id);
    assert.equal(terminal.taskId, waiting.id);
    assert.match(lines.join('\n'), /Which filename/);
  } finally { await reopened?.close(); await f.close(); }
});

test('H05/H06 delivery paths include empty files and Chinese directories; changed or unverified versions cannot open', async () => {
  const f = await scriptedFixture(() => fauxAssistantMessage(fauxToolCall('task_submit', {summary:'Files ready', artifacts:['交付', 'empty.txt']}), {stopReason:'toolUse'}));
  try {
    await mkdir(join(f.workspace, '交付'));
    await writeFile(join(f.workspace, '交付', '说明.md'), '说明');
    await writeFile(join(f.workspace, 'empty.txt'), '');
    const task = await f.runtime.create('Deliver existing synthetic files', f.workspace);
    const done = await until(() => f.runtime.status(task.id), s => s.status === 'completed');
    assert.equal((await artifactTarget(done, 0)).kind, 'directory');
    assert.equal((await artifactTarget(done, 1)).bytes, 0);
    assert.equal((await f.runtime.artifacts(task.id)).every(a => a.state === 'verified'), true);
    await writeFile(join(f.workspace, 'empty.txt'), 'changed');
    await assert.rejects(artifactTarget(done, 1), /changed/i);
    assert.equal((await f.runtime.artifacts(task.id))[1]!.state, 'changed');
    await assert.rejects(artifactTarget({...done,status:'verifying'}, 0), /verified/i);
    const escaped = structuredClone(done);
    escaped.goal!.candidate!.artifacts[0] = '../outside.txt';
    await assert.rejects(artifactTarget(escaped, 0), /outside|scope/i);
  } finally { await f.close(); }
});

test('C02 model switching, scoped phone pairing and durable reminders work through the authenticated daemon', async () => {
  const f = await scriptedFixture(context => fauxAssistantMessage(
    context.messages.some(message => message.role === 'user' && message.content === 'continue old conversation')
      ? 'Original model continued' : 'OK',
  ));
  const extra = fauxProvider({provider:'second-test',models:[{id:'second'}]});
  extra.setResponses(Array.from({length:10}, () => fauxAssistantMessage('OK')));
  f.models.setProvider(extra.provider);
  const settings = {...f.settings,port:await portNumber()};
  let server = await serve(settings,{models:f.models});
  const client = createClient(settings);
  try {
    assert.equal((await client.request<{mode:string}>('/v1/computer')).mode,'disabled');
    await assert.rejects(client.request('/v1/computer/takeover','POST',{}),/disabled/);
    const old = await client.request<{id:string;model:unknown}>('/v1/tasks','POST',{objective:'old',mode:'chat'});
    const ref = {provider:'second-test',modelId:'second'};
    const check = await client.request<{status:string}>('/v1/settings/models/check','POST',ref);
    assert.equal(check.status,'available');
    await client.request('/v1/settings/models/select','POST',ref);
    const next = await client.request<{id:string;model:unknown}>('/v1/tasks','POST',{objective:'new',mode:'chat'});
    assert.deepEqual(next.model,ref);
    assert.deepEqual((await server.runtime.status(old.id)).model, old.model);
    assert.deepEqual(await client.request('/v1/settings/mcp'), []);
    const device = await client.request<{token:string}>('/v1/remote/devices','POST',{accountId:'owner',deviceId:'phone'});
    const remote = () => fetch(`http://127.0.0.1:${settings.port}/remote/api/session`,{headers:{Authorization:'Bearer '+device.token}});
    assert.equal((await remote()).status,200);
    const daemonToken = (await readFile(join(f.directory,'token'),'utf8')).trim();
    assert.notEqual(device.token,daemonToken);
    await client.request('/v1/remote/devices/owner/phone','DELETE');
    assert.equal((await remote()).status,401);
    const rule = await client.request<{id:string}>('/v1/routines','POST',{action:'notify',objective:'Synthetic reminder',schedule:{kind:'once',at:new Date(Date.now()+250).toISOString()}});
    await until(() => server.runtime.notifications(), events => events.some(event => event.routineId === rule.id));
    const historyPath='/v1/routines/'+rule.id+'/occurrences';
    const history=await client.request<{routineId:string;status:string;sequence:number}[]>(historyPath);
    assert.equal(history.length,2);assert.equal(history[0]!.routineId,rule.id);assert.deepEqual(history.map(row=>row.status),['claimed','notified']);
    const before = await server.runtime.notifications();
    await server.close();
    server = await serve(settings,{models:f.models});
    assert.deepEqual(await server.runtime.notifications(),before);
    assert.deepEqual((await server.runtime.status(next.id)).model,ref);
    const answers: string[] = [];
    const terminal = new ChatSession(client, event => {
      if (event.kind === 'answer') answers.push(event.text);
    });
    await terminal.handle(`/attach ${old.id}`);
    await terminal.handle('continue old conversation');
    await until(async () => { await terminal.poll(); return answers; }, values => values.includes('Original model continued'));
    assert.deepEqual((await server.runtime.status(old.id)).model, f.settings.model);
    assert.equal((await client.request<{id:string}[]>('/v1/routines'))[0]!.id,rule.id);
    assert.deepEqual(await client.request(historyPath),history);
  } finally { await server.close(); await f.close(); }
});

test('R03 repeated routine deliveries notify only when the verified output changes', async () => {
  const f = await scriptedFixture(() => fauxAssistantMessage(fauxToolCall('task_submit',{summary:'Project summary',artifacts:['summary.txt']}),{stopReason:'toolUse'}));
  try {
    await writeFile(join(f.workspace,'summary.txt'),'unchanged');
    const run = async (at:string) => {
      const task = await f.runtime.create('Scheduled summary',f.workspace,[],{routineOccurrenceId:'summary/1/'+at,notifyOnChange:true});
      return until(() => f.runtime.status(task.id),status => status.status === 'completed');
    };
    await run('2026-11-23T12:00:00.000Z');
    await run('2026-11-24T12:00:00.000Z');
    assert.equal((await f.runtime.notifications()).filter(event => event.event === 'completed').length,1);
    await writeFile(join(f.workspace,'summary.txt'),'new work');
    await run('2026-11-25T12:00:00.000Z');
    assert.equal((await f.runtime.notifications()).filter(event => event.event === 'completed').length,2);
  } finally { await f.close(); }
});

test('project model settings apply at creation and leave existing Pi sessions pinned after restart', async () => {
  const f = await scriptedFixture(() => fauxAssistantMessage('Original model continued'));
  const extra = fauxProvider({ provider: 'project-test', models: [{ id: 'alternate' }] });
  extra.setResponses(Array.from({ length: 10 }, () => (context) => fauxAssistantMessage(
    context.messages.some(message => message.role === 'user' && message.content === 'Continue the original chat')
      ? 'Project model handled the new turn' : 'Project model ready',
  )));
  f.models.setProvider(extra.provider);
  const settings = { ...f.settings, port: await portNumber() };
  const nested = join(f.workspace, 'subdirectory');
  const sibling = join(f.directory, 'separate-workspace');
  await Promise.all([mkdir(nested), mkdir(sibling), writeFile(join(f.workspace, '.kada-project'), '')]);
  let server = await serve(settings, { models: f.models });
  const client = createClient(settings);
  const ref = { provider: 'project-test', modelId: 'alternate' };
  const modelSettings = '/v1/settings/models';
  const workspaceQuery = '?workspace=' + encodeURIComponent(nested);
  const create = (workspace?: string) => client.request<{ id: string; model: typeof ref }>(
    '/v1/tasks', 'POST', { objective: 'Verify workspace model', mode: 'chat', workspace },
  );
  try {
    await client.request(`${modelSettings}/check`, 'POST', ref);
    await client.request(`${modelSettings}/select`, 'POST', { ...ref, workspace: f.workspace });
    const selected = await create(nested);
    assert.deepEqual(selected.model, ref);
    assert.deepEqual((await create(join(f.workspace, 'new', 'missing-subdirectory'))).model, ref);
    assert.deepEqual((await create(sibling)).model, settings.model);
    assert.deepEqual((await create()).model, settings.model);
    await client.request(modelSettings + workspaceQuery, 'DELETE');
    await server.close();
    server = await serve(settings, { models: f.models });
    assert.deepEqual((await create(f.workspace)).model, settings.model);
    const answers: string[] = [];
    const terminal = new ChatSession(client, event => { if (event.kind === 'answer') answers.push(event.text); });
    await terminal.handle(`/attach ${selected.id}`);
    await terminal.handle('Continue the original chat');
    await until(async () => { await terminal.poll(); return answers; }, values => values.includes('Project model handled the new turn'));
    assert.deepEqual((await server.runtime.status(selected.id)).model, ref);
  } finally { await server.close(); await f.close(); }
});

test('the authenticated routine run endpoint returns the same receipt for a repeated request', async () => {
  const f = await scriptedFixture(() => fauxAssistantMessage('No model needed'));
  const settings = { ...f.settings, port: await portNumber() };
  const server = await serve(settings, { models: f.models });
  const client = createClient(settings);
  const id = 'manual-notification';
  const at = new Date(Date.now() + 3_600_000).toISOString();
  const path = `/v1/routines/${id}`;
  try {
    await client.request('/v1/routines', 'POST', {
      id, action: 'notify', objective: 'Check the local inbox', schedule: { kind: 'once', at },
    });
    const unauthenticated = await fetch(`http://127.0.0.1:${settings.port}${path}/run`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"requestId":"retry-me"}',
    });
    assert.equal(unauthenticated.status, 401);
    const run = () => client.request<{ id: string; trigger: string; status: string }>(path + '/run', 'POST', { requestId: 'retry-me' });
    const original = await run();
    assert.equal(original.status, 'claimed');
    assert.equal(original.trigger, 'manual');
    assert.deepEqual(await run(), original);
    const events = await until(() => server.runtime.notifications(), rows => rows.some(row => row.routineId === id));
    assert.equal(events.filter(row => row.routineId === id).length, 1);
    const rules = await server.runtime.routines.list();
    assert.equal(rules.find(rule => rule.id === id)?.nextRunAt, at);
  } finally { await server.close(); await f.close(); }
});

test('the owner can read and change the project memory capture setting across daemon restart', async () => {
  const f = await scriptedFixture(() => fauxAssistantMessage('No model needed'));
  const settings = { ...f.settings, discovery: true, port: await portNumber() };
  const home = join(f.directory, 'synthetic-home');
  await mkdir(home);
  const options = { models: f.models, discovery: { home } };
  let server = await serve(settings, options);
  const client = createClient(settings);
  const path = '/v1/settings/memory/capture';
  const query = '?workspace=' + encodeURIComponent(f.workspace);
  try {
    const outside = await fetch(`http://127.0.0.1:${settings.port}${path}${query}`);
    assert.equal(outside.status, 401);
    const initial = await client.request<{ project: string; enabled: boolean }>(path + query);
    assert.equal(initial.enabled, true);
    await assert.rejects(client.request(path, 'PUT', { workspace: f.workspace, enabled: 'false' }), /boolean/i);
    assert.deepEqual(await client.request(path, 'PUT', { workspace: f.workspace, enabled: false }), { ...initial, enabled: false });
    await server.close();
    server = await serve(settings, options);
    assert.deepEqual(await client.request(path + query), { ...initial, enabled: false });
    assert.deepEqual(await client.request(path, 'PUT', { workspace: f.workspace, enabled: true }), initial);
  } finally { await server.close(); await f.close(); }
});

test('the authenticated event endpoint only runs the saved rule for a matching event', async () => {
  const f = await scriptedFixture(() => fauxAssistantMessage('No model needed'));
  const settings = { ...f.settings, port: await portNumber() };
  const server = await serve(settings, { models: f.models });
  const client = createClient(settings);
  const id = 'inventory-watch';
  const at = new Date(Date.now() + 3_600_000).toISOString();
  const path = `/v1/routines/${id}/events`;
  const event = { source: 'inventory', type: 'item.changed', eventId: 'warehouse-1', data: { warehouse: 'east' } };
  try {
    await client.request('/v1/routines', 'POST', {
      id, action: 'notify', objective: 'Check the inventory report', schedule: { kind: 'once', at },
      event: { source: event.source, type: event.type, equals: { warehouse: 'east' } },
    });
    const response = await fetch(`http://127.0.0.1:${settings.port}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(event),
    });
    assert.equal(response.status, 401);
    const filtered = await client.request<{ outcome: string }>(path, 'POST', {
      ...event, eventId: 'ignored', data: { warehouse: 'west' },
    });
    assert.equal(filtered.outcome, 'filtered');
    assert.equal((await server.runtime.notifications()).length, 0);
    const accepted = await client.request<{ outcome: string }>(path, 'POST', event);
    assert.equal(accepted.outcome, 'accepted');
    assert.deepEqual(await client.request(path, 'POST', event), accepted);
    const events = await until(() => server.runtime.notifications(), rows => rows.some(row => row.routineId === id));
    assert.deepEqual(events.filter(row => row.routineId === id).map(row => row.detail), ['Check the inventory report']);
    assert.equal((await server.runtime.routines.list()).find(rule => rule.id === id)?.nextRunAt, at);
  } finally { await server.close(); await f.close(); }
});

test('memory candidate decisions are scoped owner actions and become searchable only after acceptance', async () => {
  const quote = 'Always show the checked sources.';
  const f = await scriptedFixture(context => {
    if (!context.messages.some(message => message.role === 'toolResult' && message.toolName === 'user_remember')) {
      return fauxAssistantMessage(fauxToolCall('user_remember', { facts: [{ text: quote, category: 'preferences',
        scope: 'project', certainty: 'stated', evidence: [{ sourceId: 'user', quote }] }] }), { stopReason: 'toolUse' });
    }
    return fauxAssistantMessage('Candidate ready for review.');
  });
  const home = join(f.directory, 'review-home');
  await mkdir(home);
  const settings = { ...f.settings, discovery: true, port: await portNumber() };
  const server = await serve(settings, { models: f.models, discovery: { home } });
  const client = createClient(settings);
  const query = '?workspace=' + encodeURIComponent(f.workspace);
  const candidates = '/v1/environment/memory/candidates';
  try {
    await client.request('/v1/settings/memory/review', 'PUT', { workspace: f.workspace, enabled: true });
    const task = await client.request<{ id: string }>('/v1/tasks', 'POST', { objective: quote, mode: 'chat', workspace: f.workspace });
    await until(() => server.runtime.status(task.id), status => status.status === 'answered');
    const [candidate] = await client.request<{ id: string; status: string }[]>(candidates + query);
    assert.equal(candidate.status, 'pending');
    assert.equal((await server.runtime.localMemory(f.workspace)).facts.some(fact => fact.text === quote), false);
    assert.equal((await fetch(`http://127.0.0.1:${settings.port}${candidates}/${candidate.id}/accept${query}`, { method: 'POST' })).status, 401);
    const accepted = await client.request(candidates + '/' + candidate.id + '/accept' + query, 'POST', {});
    assert.deepEqual(await client.request(candidates + '/' + candidate.id + '/accept' + query, 'POST', {}), accepted);
    assert.equal((await server.runtime.localMemory(f.workspace)).facts.filter(fact => fact.text === quote).length, 1);
  } finally { await server.close(); await f.close(); }
});
