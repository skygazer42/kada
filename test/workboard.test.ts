import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import { createClient } from '../src/client.js';
import { serve } from '../src/server.js';
import { WorkItems } from '../src/work-items.js';
import { scriptedFixture } from './helpers.js';

test('custom columns and card order are durable, scoped and bound to the original versions', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'kada-workboard-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const project = join(directory, 'project'), foreign = join(directory, 'foreign');
  await Promise.all([mkdir(project), mkdir(foreign)]);
  const open = () => new WorkItems(directory, { task: async () => undefined, tasks: async () => [], reopen: async () => {},
    start: async () => { throw new Error('Board operations must not start work.'); } });
  const work = open();
  const first = await work.create({ workspace: project, title: 'First', objective: 'First scope.' });
  const next = await work.create({ workspace: project, title: 'Second', objective: 'Second scope.' });
  const outside = await work.create({ workspace: foreign, title: 'Foreign', objective: 'Different project.' });
  assert(Array.isArray(JSON.parse(await readFile(join(directory, 'work-items.json'), 'utf8'))));
  let board = await work.board(project);
  assert.deepEqual(board.columns.map(column => column.id), ['open', 'parked', 'done']);
  assert.deepEqual(board.columns[0]?.items.map(item => item.id), [first.id, next.id]);
  const add = { action: 'add-column', version: board.version, requestId: 'add-review', title: 'Review', status: 'open' };
  const review = await work.editBoard(project, add);
  assert(review.columnId);
  assert.deepEqual(await work.editBoard(project, add), review);
  await assert.rejects(work.editBoard(project, { ...add, title: 'Another name' }), /different content/i);
  board = await work.board(project);
  const move = { action: 'move-card', version: board.version, requestId: 'move-second', itemId: next.id, itemRevision: next.revision, columnId: review.columnId };
  await assert.rejects(work.editBoard(project, { ...move, itemId: outside.id }), /not found/i);
  const moved = await work.editBoard(project, move);
  assert.deepEqual(await work.editBoard(project, move), moved);
  await assert.rejects(work.editBoard(project, { ...move, requestId: 'stale-view' }), /board.*changed/i);
  board = await work.board(project);
  const current = await work.get(first.id);
  await work.editBoard(project, { action: 'move-card', version: board.version, requestId: 'move-first', itemId: first.id,
    itemRevision: current.revision, columnId: review.columnId, beforeId: next.id });
  const reopened = open();
  board = await reopened.board(project);
  assert.deepEqual(board.columns.find(column => column.id === review.columnId)?.items.map(item => item.id), [first.id, next.id]);
  await assert.rejects(reopened.editBoard(project, { action: 'remove-column', version: board.version, requestId: 'remove-occupied', columnId: review.columnId }), /move.*cards|empty/i);
  await reopened.editBoard(project, { action: 'move-card', version: board.version, requestId: 'complete-first', itemId: first.id,
    itemRevision: (await reopened.get(first.id)).revision, columnId: 'done' });
  assert.equal((await reopened.get(first.id)).status, 'done');
  assert((await reopened.get(first.id)).completedAt);
  assert.deepEqual((await reopened.board(foreign)).columns[0]?.items.map(item => item.id), [outside.id]);
  assert.deepEqual(await reopened.runs(first.id), []);
});

test('a browser workboard ticket grants only the original project and only board operations', async t => {
  const f = await scriptedFixture(() => fauxAssistantMessage('Unused.'));
  await f.runtime.close();
  const socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const settings = { ...f.settings, port }, origin = `http://127.0.0.1:${port}`;
  const daemon = await serve(settings, { models: f.models });
  t.after(async () => { await daemon.close(); await f.close(); });
  const foreign = join(f.directory, 'foreign');
  await mkdir(foreign);
  const outside = await daemon.runtime.workItems.create({ workspace: foreign, title: 'Outside board', objective: 'Other project.' });
  const client = createClient(settings);
  const { url } = await client.request<{ url: string }>('/v1/work-items/board-link', 'POST', { workspace: f.workspace });
  const ticket = new URL(url).hash.slice(1);
  const session = (authorizationOrigin = origin) => fetch(origin + '/workboard/session', { method: 'POST',
    headers: { origin: authorizationOrigin, 'content-type': 'application/json' }, body: JSON.stringify({ ticket }) });
  assert.equal((await session('https://example.invalid')).status, 403);
  assert.equal((await fetch(origin + '/workboard/board')).status, 401);
  const { token } = await (await session()).json();
  assert.equal((await session()).status, 401);
  const use = (path: string, method = 'GET', body?: unknown) => fetch(origin + path, { method,
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.equal((await use('/v1/work-items?workspace=' + encodeURIComponent(foreign))).status, 401);
  assert.equal((await use('/workboard/items/' + outside.id, 'PATCH', { requestId: 'foreign-edit', title: 'Foreign edit', revision: outside.revision })).status, 404);
  const input = { requestId: 'owner-create', workspace: foreign, title: 'Here', objective: 'Same project.' };
  const created = await use('/workboard/items', 'POST', input);
  assert.equal(created.status, 201);
  const item = await created.json();
  assert.equal(item.workspace, f.workspace);
  assert.deepEqual(await (await use('/workboard/items', 'POST', input)).json(), item);
  assert.equal((await use('/workboard/items', 'POST', { ...input, title: 'Conflicting retry' })).status, 409);
  const board = await (await use('/workboard/board?workspace=' + encodeURIComponent(foreign))).json();
  assert.deepEqual(board.columns[0].items.map((row: { id: string }) => row.id), [item.id]);
  const page = await fetch(origin + '/workboard');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy') ?? '', /script-src 'nonce-/);
  assert.doesNotMatch(await page.text(), /Outside board/);
});
