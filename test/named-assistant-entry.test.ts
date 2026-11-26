import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import { serve } from '../src/server.js';
import { createClient } from '../src/client.js';
import { ChatSession } from '../src/chat.js';
import { VERSION } from '../src/version.js';
import { scriptedFixture, until } from './helpers.js';

const execute = promisify(execFile);

test('owner API and CLI manage role revisions, and the terminal selects a role without starting work during setup', async t => {
  const f = await scriptedFixture(context => { assert(JSON.stringify(context.messages).includes('ENTRY_ROLE_416')); return fauxAssistantMessage('Role selected.'); });
  const socket = createServer(); await new Promise<void>(done => socket.listen(0, '127.0.0.1', done));
  const port = (socket.address() as { port: number }).port; await new Promise<void>(done => socket.close(() => done()));
  const config = { ...f.settings, port }, server = await serve(config, { models: f.models });
  t.after(async () => { await server.close(); await f.close(); });
  const token = (await readFile(join(f.directory, 'token'), 'utf8')).trim(), base = 'http://127.0.0.1:' + port;
  const api = (path: string, method = 'GET', body?: unknown, bearer = token) => fetch(base + path, { method,
    headers: { Authorization: 'Bearer ' + bearer, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const client = createClient(config);
  assert.equal(await client.healthy('named-assistants'), true);
  assert.equal((await api('/v1/assistants?workspace=' + encodeURIComponent(f.workspace), 'GET', undefined, 'wrong')).status, 401);
  const created = await api('/v1/assistants', 'POST', { workspace: f.workspace, name: '终端研究员', instructions: 'ENTRY_ROLE_416', tools: ['read'] });
  assert.equal(created.status, 201); const role = await created.json();
  assert.equal((await api('/v1/assistants/' + role.id, 'PATCH', { revision: 0, instructions: 'Bad edit' })).status, 400);
  const list = await (await api('/v1/assistants?workspace=' + encodeURIComponent(f.workspace))).json();
  assert.equal(list[0].id, role.id); assert(!Object.hasOwn(list[0], 'instructions'));
  const configFile = join(f.directory, 'config.json'), definitionFile = join(f.directory, 'role.json'), editFile = join(f.directory, 'edit.json');
  await writeFile(configFile, JSON.stringify(config));
  await writeFile(definitionFile, JSON.stringify({ name: '第二个助手', instructions: 'ENTRY_ROLE_416', tools: ['read'] }));
  const cli = (...args: string[]) => execute(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args, '--config', configFile], { cwd: process.cwd() });
  const added = JSON.parse((await cli('assistants', 'add', definitionFile, '--workspace', f.workspace)).stdout);
  assert.equal(added.revision, 1); assert.equal((await server.runtime.list()).length, 0);
  assert.equal(JSON.parse((await cli('assistants', 'show', role.id)).stdout).instructions, 'ENTRY_ROLE_416');
  await writeFile(editFile, JSON.stringify({ revision: 1, description: 'Updated metadata' }));
  assert.equal(JSON.parse((await cli('assistants', 'edit', role.id, editFile)).stdout).revision, 2);
  assert.equal((await api('/v1/assistants/' + role.id, 'PATCH', { revision: 1, name: 'Stale' })).status, 409);
  const events: string[] = [], ref = { id: role.id, revision: 2 };
  const chat = new ChatSession(client, event => events.push(event.text), f.workspace, undefined, ref);
  await chat.handle('Say hello in this role.');
  const answer = await until(() => server.runtime.status(chat.taskId!), row => ['answered', 'failed'].includes(row.status));
  assert.equal(answer.status, 'answered'); assert.equal(answer.goal, undefined); assert.equal(answer.assistant?.id, role.id);
  await chat.attach(answer.id); assert(events.some(text => text.includes('终端研究员') && text.includes('v2')));
  assert.equal((await api('/v1/tasks/' + answer.id + '/messages', 'POST', { message: 'Change role.', assistant: { id: added.id, revision: 1 } })).status, 409);
  const output = (await cli('run', 'Role task', '--workspace', f.workspace, '--assistant', role.id + '@2', '--detach')).stdout;
  const runId = /Task: ([a-f0-9-]{36})/.exec(output)?.[1]; assert(runId);
  assert.equal((await server.runtime.metadata(runId)).assistant?.revision, 2);
  await assert.rejects(cli('chat', answer.id, '--assistant', role.id + '@2'));
});

test('a same-version daemon without role support is rejected before a selected role can become an unrestricted task', async t => {
  let posts = 0;
  const f = await scriptedFixture(() => fauxAssistantMessage('Unused.'));
  const server = createServer((req, res) => {
    if (req.url === '/health') res.setHeader('Content-Type', 'application/json').end(JSON.stringify({ status: 'ok', version: VERSION, capabilities: ['ordinary-chat'] }));
    else { posts++; res.writeHead(500).end(); }
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); await f.close(); });
  const config = { ...f.settings, port: (server.address() as { port: number }).port }, client = createClient(config);
  assert.equal(await client.healthy(), true); assert.equal(await client.healthy('named-assistants'), false);
  const ref = { id: 'af7c6809-2b4f-4dce-81d5-63e6eeb33cbe', revision: 1 };
  const chat = new ChatSession(client, () => {}, f.workspace, undefined, ref);
  await assert.rejects(chat.handle('Use the selected role.'), /assistant|助手|角色/);
  const path = join(f.directory, 'old-config.json'); await writeFile(path, JSON.stringify(config));
  await assert.rejects(execute(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'run', 'Use role', '--assistant', ref.id + '@1', '--workspace', f.workspace, '--config', path, '--detach', '--yes'], { cwd: process.cwd() }));
  assert.equal(posts, 0);
});
