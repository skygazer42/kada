import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxToolCall, type TranscriptContext } from '@earendil-works/pi-ai';
import { LocalRuntime } from '../src/runtime.js';
import { scriptedFixture, until, hasTool } from './helpers.js';
import { runChat } from '../src/chat.js';
import { PassThrough } from 'node:stream';
import { createServer, request as httpRequest } from 'node:http';
import type { request as HttpsRequest } from 'node:https';
import { serve } from '../src/server.js';

const value = 'synthetic-private-input-743';
const users = (c: TranscriptContext) => c.messages.filter(message => message.role === 'user').map(message => String(message.content));
const call = (name: string, args: Record<string, unknown>) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' });
const destination = { name: 'reports', origin: 'https://api.example', auth: { type: 'bearer' } };

test('a local chat requests a credential through protected input, keeps the value outside Pi, and resumes once after restart', async t => {
  let requests = 0;
  const f = await scriptedFixture(c => {
    requests++; assert(!JSON.stringify(c).includes(value));
    assert(hasTool(c, 'request_credential')); assert(!hasTool(c, 'credential_request'));
    if (users(c).some(text => text.includes('Credential reports saved'))) return fauxAssistantMessage('Credential reports saved; no work started.');
    return call('request_credential', { ...destination, label: 'Reports API credential', reason: 'Read the report service.' });
  });
  let runtime = f.runtime;
  t.after(async () => { await runtime.close(); await f.close(); });
  const chat = await runtime.create('Configure the report credential.', f.workspace, [], { chat: true });
  const waiting = await until(() => runtime.status(chat.id), row => ['waiting_user', 'failed'].includes(row.status));
  assert.equal(waiting.status, 'waiting_user'); assert.equal(waiting.goal, undefined);
  assert.equal(waiting.userQuestion?.credential?.name, 'reports'); assert.deepEqual(waiting.userQuestion?.options, []);
  await assert.rejects(runtime.answerQuestion(chat.id, waiting.userQuestion!.id, 'plain-answer', value), { status: 400 });
  await assert.rejects(runtime.followUp(chat.id, value, 'plain-message'), /protected|credential/i);
  const before = await runtime.status(chat.id); assert(!JSON.stringify(before.messages).includes(value));
  await runtime.close(); runtime = new LocalRuntime(f.settings, { models: f.models }); await runtime.recover();
  assert.equal(requests, 1);
  await runtime.provideCredential(chat.id, waiting.userQuestion!.id, value);
  const done = await until(() => runtime.status(chat.id), row => row.status === 'answered');
  assert.equal(done.goal, undefined); assert.equal(done.userQuestion, null); assert.equal(requests, 2);
  assert(!JSON.stringify(done).includes(value));
  assert.equal((await runtime.credentials.list(f.workspace))[0].revision, 1);
  assert((await readFile(join(f.directory, 'tasks', chat.id, 'session.sqlite'))).includes(Buffer.from(value)) === false);
  await runtime.provideCredential(chat.id, waiting.userQuestion!.id, value); assert.equal(requests, 2);
  await assert.rejects(runtime.provideCredential(chat.id, waiting.userQuestion!.id, 'different-value'), { status: 409 });
});

test('declining a protected credential request returns no secret and preserves a normal conversation', async t => {
  const f = await scriptedFixture(c => users(c).some(text => text.includes('Credential reports declined')) ? fauxAssistantMessage('No credential saved.') :
    call('request_credential', { ...destination, label: 'Reports', reason: 'Read reports.' }));
  t.after(() => f.close());
  const chat = await f.runtime.create('Request credential.', f.workspace, [], { chat: true });
  const waiting = await until(() => f.runtime.status(chat.id), row => ['waiting_user', 'failed'].includes(row.status));
  assert.equal(waiting.status, 'waiting_user');
  await f.runtime.provideCredential(chat.id, waiting.userQuestion!.id, undefined);
  const done = await until(() => f.runtime.status(chat.id), row => row.status === 'answered');
  assert.deepEqual(await f.runtime.credentials.list(f.workspace), []); assert.equal(done.goal, undefined);
});

test('terminal protected input never echoes its value or sends it through the messages route', async t => {
  const originalTerm = process.env.TERM; process.env.TERM = 'xterm';
  t.after(() => { if (originalTerm === undefined) delete process.env.TERM; else process.env.TERM = originalTerm; });
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  const output = Object.assign(new PassThrough(), { isTTY: true });
  let text = '', supplied = false;
  output.on('data', chunk => { text += String(chunk); });
  const client = { healthy: async () => true, request: async <T>(path: string, method = 'GET', body?: unknown): Promise<T> => {
    if (path.endsWith('/notifications/read')) return {} as T;
    if (path.endsWith('/credentials/42')) {
      assert.deepEqual(body, { value }); supplied = true; return { accepted: true } as T;
    }
    assert.equal(method, 'GET', 'no ordinary message is sent');
    return { id: 'chat', interaction: 'chat', objective: 'Configure reports', workspace: 'project', status: supplied ? 'answered' : 'waiting_user',
      messages: [], delegations: [], userQuestion: supplied ? null : { id: '42', text: 'Reports API', options: [], createdAt: 1,
        credential: { ...destination, expectedRevision: 0 } }, workerCount: 0 } as T;
  } };
  const running = runChat(client, { taskId: 'chat', input, output, intervalMs: 20 });
  try {
    await until(async () => text, row => row.includes('/credential 42'));
    input.write('/credential 42\n');
    await until(async () => text, row => row.includes('无回显，按 Enter'));
    input.write(value); input.write('\x03');
    await until(async () => text, row => row.includes('凭据输入已取消'));
    const afterCancel = text.length;
    input.write('/credential 42\n');
    await until(async () => text.slice(afterCancel), row => row.includes('无回显，按 Enter') || row.includes('错误：'));
    assert(text.slice(afterCancel).includes('无回显，按 Enter'), 'cancelled private text must not become a normal chat prefix');
    input.write('synthetic-discarded-edit');
    await new Promise<void>(done => setImmediate(done));
    input.write('\x15');
    await new Promise<void>(done => setImmediate(done));
    input.write(value + '\n');
    await until(async () => supplied, Boolean);
    input.write('\x19/help\n');
    await until(async () => text, row => row.includes('直接输入消息：普通问答直接回复'));
    input.write('/quit\n'); await running;
    assert(!text.includes(value));
    assert(!text.includes('synthetic-discarded-edit'), 'private kill/yank buffers cannot reappear in chat');
  } finally { input.end(); await running; }
});

test('a confirmed main task uses the named credential once while workers and remote or historical tasks have no credential tools', async t => {
  let networkCalls = 0;
  const service = createServer((req, res) => { assert.equal(req.headers.authorization, 'Bearer ' + value); networkCalls++; res.end('REPORT_742'); });
  await new Promise<void>(done => service.listen(0, '127.0.0.1', done));
  t.after(() => new Promise<void>(done => service.close(() => done())));
  const port = (service.address() as { port: number }).port;
  const network = { lookup: async () => [{ address: '8.8.8.8', family: 4 }], request: ((options: any, done: any) =>
    httpRequest({ ...options, protocol: 'http:', hostname: '127.0.0.1', port, lookup: undefined }, done)) as typeof HttpsRequest };
  const f = await scriptedFixture(c => {
    assert(!JSON.stringify(c).includes(value));
    if (!hasTool(c, 'delegate')) {
      assert(!hasTool(c, 'credential_request')); assert(!hasTool(c, 'credentials_list')); assert(!hasTool(c, 'request_credential'));
      return fauxAssistantMessage('No credential access.');
    }
    const results = c.messages.filter(message => message.role === 'toolResult');
    if (!results.some(result => result.toolName === 'delegate')) return call('delegate', { tasks: [{ name: 'reader', instructions: 'Inspect independent evidence.' }] });
    if (!results.some(result => result.toolName === 'credential_request')) return call('credential_request', { name: 'reports', revision: 1, url: 'https://api.example/report', method: 'GET' });
    assert.equal(results.find(result => result.toolName === 'credential_request')!.isError, false);
    return call('task_submit', { summary: 'REPORT_742 returned.', artifacts: [] });
  }, {}, () => [], { credentialNetwork: network });
  t.after(() => f.close());
  await f.runtime.credentials.save({ ...destination, auth: { type: 'bearer' }, project: f.workspace, value, expectedRevision: 0, requestId: 'owner-save' });
  const task = await f.runtime.create('Read the report service.', f.workspace);
  await until(() => f.runtime.status(task.id), row => row.status === 'completed');
  assert.equal(networkCalls, 1);
  const deny = await scriptedFixture(c => {
    if (users(c).at(-1) !== 'Historical seed') for (const tool of ['credential_request', 'request_credential', 'credentials_list']) assert(!hasTool(c, tool));
    return fauxAssistantMessage('No credentials.');
  });
  let runtime = deny.runtime;
  t.after(async () => { await runtime.close(); await deny.close(); });
  const remote = await runtime.create('Remote', deny.workspace, [], { chat: true, remote: true });
  await until(() => runtime.status(remote.id), row => row.status === 'answered');
  await assert.rejects(runtime.provideCredential(remote.id, '42', value), { status: 404 });
  const old = await runtime.create('Historical seed', deny.workspace, [], { chat: true, id: '4239b5de-34ac-4c05-bc42-03f96f7d7119' });
  await until(() => runtime.status(old.id), row => row.status === 'answered');
  const meta = await runtime.metadata(old.id); delete meta.credentialProject;
  await runtime.close(); await writeFile(join(deny.directory, 'tasks', old.id, 'task.json'), JSON.stringify(meta));
  runtime = new LocalRuntime(deny.settings, { models: deny.models }); await runtime.recover();
  await runtime.followUp(old.id, 'Historical follow-up', 'old');
  await until(() => runtime.status(old.id), row => row.status === 'answered');
});

test('owner API saves protected input only for its original request and never returns the value', async t => {
  const f = await scriptedFixture(c => users(c).some(text => text.includes('Credential reports saved')) ? fauxAssistantMessage('Saved.') :
    call('request_credential', { ...destination, label: 'Reports', reason: 'Read reports.' }));
  const socket = createServer(); await new Promise<void>(done => socket.listen(0, '127.0.0.1', done));
  const port = (socket.address() as { port: number }).port; await new Promise<void>(done => socket.close(() => done()));
  const server = await serve({ ...f.settings, port }, { models: f.models });
  t.after(async () => { await server.close(); await f.close(); });
  const token = (await readFile(join(f.directory, 'token'), 'utf8')).trim();
  const request = (bearer: string, path: string, body?: object, method = 'POST') => fetch('http://127.0.0.1:' + port + path, {
    method, headers: { Authorization: 'Bearer ' + bearer, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const chat = await server.runtime.create('Configure reports.', f.workspace, [], { chat: true });
  const waiting = await until(() => server.runtime.status(chat.id), row => row.status === 'waiting_user' && row.submission?.status === 'done');
  const path = '/v1/tasks/' + chat.id + '/credentials/' + waiting.userQuestion!.id;
  assert.equal((await request('wrong', path, { value })).status, 401);
  assert.equal((await request(token, path, { value, decline: true })).status, 400);
  assert.equal((await request(token, path.replace(/\d+$/, '99999'), { value })).status, 404);
  const response = await request(token, path, { value }); assert.equal(response.status, 200); assert(!JSON.stringify(await response.json()).includes(value));
  await until(() => server.runtime.status(chat.id), row => row.status === 'answered');
  assert.equal((await request(token, path, { value })).status, 200);
  const list = await request(token, '/v1/credentials?workspace=' + encodeURIComponent(f.workspace), undefined, 'GET');
  assert(!JSON.stringify(await list.json()).includes(value));
});
