import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { createClient } from '../src/client.js';
import { serve } from '../src/server.js';
import { scriptedFixture, until } from './helpers.js';

test('a paired device sees only granted original rooms and sends once under its independent reply grant', async t => {
  const firstReply = Promise.withResolvers<void>();
  const originalText = 'the original mobile input';
  const fixture = await scriptedFixture(async context => {
    const last = context.messages.findLastIndex(message => message.role === 'user');
    const input = JSON.parse(String(context.messages[last]?.content));
    if (input.message === originalText) await firstReply.promise;
    if (input.attachments?.length) {
      const file = context.messages.slice(last).find(message => message.role === 'toolResult' && message.toolName === 'room_read_file');
      if (!file) return fauxAssistantMessage(fauxToolCall('room_read_file', { id: 1 }), { stopReason: 'toolUse' });
      assert.match(JSON.stringify(file), /Original attached file content/);
    }
    if (input.message === 'Ask about shared history') {
      assert.doesNotMatch(JSON.stringify(context.messages), /Original attached file content/);
    }
    return fauxAssistantMessage('Original reply for ' + input.message);
  });
  await fixture.runtime.close();
  const socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const config = { ...fixture.settings, port };
  const server = await serve(config, { models: fixture.models });
  t.after(async () => { firstReply.resolve(); await server.close(); await fixture.close(); });
  const client = createClient(config);
  const define = (name: string, tools: string[] = []) => server.runtime.assistants.create({ workspace: fixture.workspace, name, instructions: 'Reply in the original room.', tools });
  const lead = await define('Lead'), review = await define('Reviewer', ['room_read_file']);
  const members = [lead, review].map(({ id, revision }) => ({ id, revision }));
  const room = await server.runtime.createRoom({ workspace: fixture.workspace, title: 'Original room', members });
  const other = await server.runtime.createRoom({ workspace: fixture.workspace, title: 'Private room', members });
  const devices = ['one', 'two'];
  const endpoints = await Promise.all(devices.map(deviceId => client.request<{ token: string }>('/v1/remote/devices', 'POST', { accountId: 'owner', deviceId })));
  const remote = (path: string, device = 0, input?: unknown) => fetch(`http://127.0.0.1:${port}/remote/api${path}`, {
    method: input === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${endpoints[device]!.token}`, 'Content-Type': 'application/json' },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  });
  const base = '/shared-rooms', path = base + '/' + room.id;
  const grant = (operation: string, deviceId: string) => client.request(`/v1/assistant-rooms/${room.id}/${operation}`, 'POST', { accountId: 'owner', deviceId });
  await grant('share', 'one');
  const list = await (await remote(base)).json();
  assert.deepEqual(list.map((row: { id: string }) => row.id), [room.id]);
  assert.equal((await remote(base + '/' + other.id)).status, 404);
  assert.equal((await remote(path, 1)).status, 404);
  assert.deepEqual(await (await remote('/shared-threads')).json(), []);
  const readOnly = await (await remote(path)).json();
  assert.equal(readOnly.canSend, false);
  assert(!JSON.stringify(readOnly).includes(fixture.workspace));
  assert(!JSON.stringify(readOnly).includes('Reply in the original room.'));
  const input = { memberId: review.id, message: originalText, requestId: 'stable-phone-id', roomRevision: readOnly.revision };
  assert.equal((await remote(path + '/messages', 0, input)).status, 403);
  await grant('share-replies', 'one');
  await grant('share', 'two');
  await grant('share-replies', 'two');
  assert.equal((await remote(path + '/messages', 0, { ...input, roomRevision: 99 })).status, 409);
  const accepted = await remote(path + '/messages', 0, input);
  assert.equal(accepted.status, 200);
  const second = { ...input, message: 'a second phone with the same request ID' };
  const queued = await remote(path + '/messages', 1, second);
  assert.equal(queued.status, 200);
  assert.equal((await queued.json()).status, 'queued');
  assert.deepEqual((await (await remote(path)).json()).messages.map((message: { status: string }) => message.status), ['running', 'queued']);
  firstReply.resolve();
  const continued = await until(() => server.runtime.roomDetails(room.id), value => value.messages.length === 4);
  assert.equal(continued.messages[2]?.text, 'Original reply for ' + input.message);
  const duplicated = await (await remote(path + '/messages', 0, input)).json();
  assert.equal(duplicated.answerEntryId, continued.messages[2]?.id);
  assert.equal(continued.messages[3]?.text, 'Original reply for a second phone with the same request ID');
  assert.equal((await remote(path + '/messages', 1, { ...input, requestId: 'phone-file', files: ['private.txt'] })).status, 400);
  await writeFile(join(fixture.workspace, 'private.txt'), 'Original attached file content.');
  await server.runtime.sendRoomMessage(room.id, { ...input, requestId: 'owner-file', files: ['private.txt'] });
  await until(() => server.runtime.roomDetails(room.id), value => value.messages.length === 6);
  const sharedFile = await (await remote(path)).json();
  const fileMessage = sharedFile.messages.find((message: { attachments?: unknown[] }) => message.attachments);
  assert.deepEqual(fileMessage?.attachments, [{ id: 1, name: 'private.txt', bytes: 31 }]);
  assert(!JSON.stringify(sharedFile).includes('Original attached file content.'));
  assert(!JSON.stringify(sharedFile).includes(fixture.workspace));
  const download = path + '/attachments/' + fileMessage.id + '/1';
  assert.equal((await remote(download)).status, 403);
  const historyReply = await remote(path + '/messages', 0, { ...input, requestId: 'shared-after-file', message: 'Ask about shared history' });
  assert.equal(historyReply.status, 200);
  const afterHistory = await until(() => server.runtime.roomDetails(room.id), view => view.active === null);
  assert.equal(afterHistory.messages.at(-1)?.text, 'Original reply for Ask about shared history');
  await grant('share-files', 'one');
  assert.equal((await remote(download, 1)).status, 403);
  const authorized = await (await remote(path)).json();
  assert.equal(authorized.messages.find((message: { id: number }) => message.id === fileMessage.id).attachments[0].href,
    '/remote/api' + download);
  const saved = await remote(download);
  assert.equal(saved.status, 200);
  assert.match(saved.headers.get('content-disposition') ?? '', /^attachment;/i);
  assert.equal(await saved.text(), 'Original attached file content.');
  await grant('unshare-files', 'one');
  assert.equal((await remote(download)).status, 403);
  assert.equal((await (await remote(path)).json()).canSend, true);
  await grant('share-files', 'one');
  const fixed = await server.runtime.roomAttachment(room.id, fileMessage.id, 1);
  await writeFile(fixed.path, 'Different content.');
  assert.equal((await remote(download)).status, 409);
  await grant('unshare', 'one');
  assert.equal((await remote(path)).status, 404);
  assert.equal((await remote(path + '/messages', 0, input)).status, 404);
  await grant('share', 'one');
  assert.equal((await remote(path + '/messages', 0, input)).status, 403);
  assert.equal((await remote(download)).status, 403);
});

test('room account access reaches later pairings and role changes revoke the same account across devices', async t => {
  let modelRequests = 0;
  const fixture = await scriptedFixture(context => {
    modelRequests++;
    const user = context.messages.findLast(message => message.role === 'user');
    return fauxAssistantMessage('Reply for ' + JSON.parse(String(user?.content)).message);
  });
  await fixture.runtime.close();
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>(resolve => listener.close(() => resolve()));
  const config = { ...fixture.settings, port };
  let server = await serve(config, { models: fixture.models });
  t.after(async () => { await server.close(); await fixture.close(); });
  const client = createClient(config);
  const defs = await Promise.all(['Lead', 'Reviewer'].map(name => server.runtime.assistants.create({
    workspace: fixture.workspace, name, instructions: 'Reply to the current room.', tools: [],
  })));
  const room = await server.runtime.createRoom({ title: 'Account room', workspace: fixture.workspace,
    members: defs.map(({ id, revision }) => ({ id, revision })) });
  const ownerPath = '/v1/assistant-rooms/' + room.id + '/accounts';
  const paired = (accountId: string, deviceId: string) =>
    client.request<{ token: string }>('/v1/remote/devices', 'POST', { accountId, deviceId });
  const first = await paired('research', 'existing');
  const other = await paired('outside', 'existing');
  const remote = (device: typeof first, path: string, input?: unknown) => fetch('http://127.0.0.1:' + port + '/remote/api' + path, {
    method: input === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + device.token, 'Content-Type': 'application/json' },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  });
  const roomPath = '/shared-rooms/' + room.id;
  const message = (requestId: string) => ({ memberId: defs[0]!.id, message: requestId, requestId, roomRevision: room.revision });
  assert.equal((await remote(first, roomPath)).status, 404);
  await assert.rejects(client.request(ownerPath + '/research', 'PUT', { role: 'operator' }), /role/i);
  assert.equal((await fetch('http://127.0.0.1:' + port + ownerPath + '/research', {
    method: 'PUT', headers: { Authorization: 'Bearer ' + first.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'participant' }),
  })).status, 401);

  const configFile = join(fixture.directory, 'room-account-config.json');
  await writeFile(configFile, JSON.stringify(config));
  const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'rooms', 'grant-account',
    room.id, 'research', 'participant', 'files', '--config', configFile]);
  assert.equal(JSON.parse(stdout).role, 'participant');
  const grants = await client.request<{ accountId: string; role: string; files: boolean }[]>(ownerPath);
  assert.deepEqual(grants.map(({ accountId, role, files }) => [accountId, role, files]), [['research', 'participant', true]]);
  assert.equal((await (await remote(first, roomPath)).json()).canSend, true);
  assert.equal((await remote(other, roomPath)).status, 404);
  await writeFile(join(fixture.workspace, 'evidence.txt'), 'Account room attachment.');
  await server.runtime.sendRoomMessage(room.id, { ...message('owner-files'), files: ['evidence.txt'] });
  const shown = await until(() => server.runtime.roomDetails(room.id), value => value.messages.length === 2 && value.active === null);
  const attachment = roomPath + '/attachments/' + shown.messages[0]!.id + '/1';
  assert.equal(await (await remote(first, attachment)).text(), 'Account room attachment.');

  await server.close();
  server = await serve(config, { models: fixture.models });
  const later = await paired('research', 'later');
  const laterList = await (await remote(later, '/shared-rooms')).json();
  assert.deepEqual(laterList.map((entry: { id: string }) => entry.id), [room.id]);
  assert.equal((await remote(other, attachment)).status, 404);
  assert.equal(await (await remote(later, attachment)).text(), 'Account room attachment.');
  assert.equal((await remote(later, roomPath + '/messages', message('authorized'))).status, 200);
  await until(() => server.runtime.roomDetails(room.id), value => value.messages.some(item => item.text === 'Reply for authorized'));
  const used = modelRequests;
  await client.request(ownerPath + '/research', 'PUT', { role: 'viewer', files: false });
  for (const device of [first, later]) {
    assert.equal((await (await remote(device, roomPath)).json()).canSend, false);
    assert.equal((await remote(device, roomPath + '/messages', message('denied'))).status, 403);
    assert.equal((await remote(device, attachment)).status, 403);
  }
  await client.request(ownerPath + '/research', 'DELETE');
  for (const device of [first, later]) {
    assert.equal((await remote(device, roomPath)).status, 404);
    assert.deepEqual(await (await remote(device, '/shared-rooms')).json(), []);
  }
  await client.request('/v1/assistant-rooms/' + room.id + '/share', 'POST', { accountId: 'research', deviceId: 'existing' });
  await client.request(ownerPath + '/research', 'PUT', { role: 'participant', files: true });
  assert.equal((await (await remote(first, roomPath)).json()).canSend, true);
  await client.request(ownerPath + '/research', 'DELETE');
  assert.equal((await (await remote(first, roomPath)).json()).canSend, false);
  assert.equal((await remote(first, attachment)).status, 403);
  assert.equal((await remote(later, roomPath)).status, 404);
  assert.equal(modelRequests, used);
});
