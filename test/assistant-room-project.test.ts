import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { promisify } from 'node:util';
import { fauxAssistantMessage, fauxToolCall, type ToolResultMessage } from '@earendil-works/pi-ai';
import { createClient } from '../src/client.js';
import { serve } from '../src/server.js';
import { hasTool, scriptedFixture, until } from './helpers.js';

const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' });

test('an owner room transfers original binary files between project members while phone replies retain chat access', { timeout: 45_000 }, async t => {
  const bytes = Buffer.from([255, 0, 3, 22]);
  const ownerBytes = Buffer.from([3, 0, 251, 15]);
  let root!: string, receiverId!: string, copied!: string, copiedOwner!: string;
  const trace: unknown[] = [];
  const f = await scriptedFixture(context => {
    const last = context.messages.findLastIndex(message => message.role === 'user');
    const input = JSON.parse(String(context.messages[last]?.content));
    const system = JSON.stringify(context.messages.filter(message => message.role === 'system'));
    const results = context.messages.slice(last).filter((message): message is ToolResultMessage => message.role === 'toolResult');
    trace.push({ message: input.message, tools: results.map(({ toolName, isError, content }) => ({ toolName, isError, content })) });
    const result = (name: string) => results.find(message => message.toolName === name);
    if (input.message === 'Paired device requests a reply') {
      assert.equal(hasTool(context, 'read'), false);
      assert.equal(hasTool(context, 'write'), false);
      assert.equal(hasTool(context, 'room_attach_file'), false);
      assert.equal(hasTool(context, 'room_save_file'), false);
      assert.doesNotMatch(JSON.stringify(context.messages), /MEMBER_WORKSPACE_19/);
      assert(input.recent.some((message: { text: string }) => message.text === 'Saved the original binary report.'));
      return fauxAssistantMessage('Answered with shared chat permission.');
    }
    if (system.includes('PROJECT_ROOM_SOURCE_19')) {
      const reads = results.filter(item => item.toolName === 'read');
      if (!reads.length) return call('read', { path: 'member.txt' });
      assert.match(JSON.stringify(reads[0]), /MEMBER_WORKSPACE_19/);
      if (reads.length === 1) return call('read', { path: join(root, 'owner-evidence.txt') });
      assert.equal(reads[1]?.isError, true);
      if (!result('room_read_file')) return call('room_read_file', { id: 1 });
      assert.match(JSON.stringify(result('room_read_file')), /OWNER_ATTACHMENT_23/);
      if (!result('room_attach_file')) return call('room_attach_file', { path: 'member-result.bin' });
      assert.equal(result('room_attach_file')?.isError, false);
      return call('room_handoff', { member_id: receiverId, message: 'Save the published file.' });
    }
    assert(system.includes('PROJECT_ROOM_RECEIVER_66'));
    assert.deepEqual(input.attachments, [{ id: 1, name: 'owner-evidence.txt', bytes: 19 },
      { id: 2, name: 'owner-original.bin', bytes: ownerBytes.length }, { id: 3, name: 'member-result.bin', bytes: bytes.length }]);
    const saves = results.filter(item => item.toolName === 'room_save_file');
    if (!saves.length) return call('room_save_file', { id: 2 });
    const savedPath = (saved: ToolResultMessage) => {
      assert.equal(saved.isError, false);
      const [content] = saved.content;
      assert(content?.type === 'text');
      return JSON.parse(content.text).path;
    };
    copiedOwner = savedPath(saves[0]!);
    if (saves.length === 1) return call('room_save_file', { id: 3 });
    copied = savedPath(saves[1]!);
    return fauxAssistantMessage('Saved the original binary report.');
  });
  root = f.workspace;
  const source = join(f.directory, 'room-source'), receiver = join(f.directory, 'room-receiver');
  await mkdir(source);
  await mkdir(receiver);
  await writeFile(join(root, 'owner-evidence.txt'), 'OWNER_ATTACHMENT_23');
  await writeFile(join(root, 'owner-original.bin'), ownerBytes);
  await writeFile(join(source, 'member.txt'), 'MEMBER_WORKSPACE_19');
  await writeFile(join(source, 'member-result.bin'), bytes);
  await f.runtime.close();
  const socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const config = { ...f.settings, port };
  let host = await serve(config, { models: f.models });
  t.after(async () => { await host.close(); await f.close(); });
  const client = createClient(config);
  const lead = await host.runtime.assistants.create({ workspace: source, name: 'Project source', instructions: 'PROJECT_ROOM_SOURCE_19',
    tools: ['read', 'write', 'room_handoff', 'room_read_file', 'room_attach_file'] });
  const next = await host.runtime.assistants.create({ workspace: receiver, name: 'Project receiver', instructions: 'PROJECT_ROOM_RECEIVER_66',
    tools: ['room_save_file'] });
  receiverId = next.id;
  const configFile = join(f.directory, 'room-project-config.json');
  await writeFile(configFile, JSON.stringify(config));
  const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'rooms', 'add', 'Cross-project room',
    lead.id + '@' + lead.revision + '=' + source, next.id + '@' + next.revision + '=' + receiver, '--workspace', root, '--config', configFile]);
  const room = JSON.parse(stdout) as { id: string; revision: number };
  const path = '/v1/assistant-rooms/' + room.id;
  const ownerMessage = { memberId: lead.id, message: 'Review and forward.', requestId: 'from-owner',
    files: ['owner-evidence.txt', 'owner-original.bin'] };
  await client.request(path + '/messages', 'POST', ownerMessage);
  const completed = await until(() => host.runtime.roomDetails(room.id), view => ['answered', 'unanswered', 'failed'].includes(view.messages[0]?.status ?? ''));
  assert.equal(completed.messages.at(-1)?.text, 'Saved the original binary report.', JSON.stringify(trace));
  assert(copied.startsWith(receiver));
  assert.deepEqual(await readFile(copied), bytes);
  assert(copiedOwner.startsWith(receiver));
  assert.deepEqual(await readFile(copiedOwner), ownerBytes);
  const published = completed.messages.find(message => message.role === 'attachment')!;
  const requestsBeforeRestart = trace.length;
  await host.close();
  host = await serve(config, { models: f.models });
  const replay = await client.request<{ answerEntryId: number }>(path + '/messages', 'POST', ownerMessage);
  assert.equal(replay.answerEntryId, completed.messages.at(-1)!.id);
  assert.equal(trace.length, requestsBeforeRestart);
  assert.deepEqual((await host.runtime.readRoomAttachment(room.id, published.id, 3)).data, bytes);
  const { token } = await client.request<{ token: string }>('/v1/remote/devices', 'POST', { accountId: 'owner', deviceId: 'room-phone' });
  await client.request(path + '/share', 'POST', { accountId: 'owner', deviceId: 'room-phone' });
  await client.request(path + '/share-replies', 'POST', { accountId: 'owner', deviceId: 'room-phone' });
  const url = 'http://127.0.0.1:' + port + '/remote/api/shared-rooms/' + room.id;
  const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  const response = await fetch(url + '/messages', { method: 'POST', headers, body: JSON.stringify({ memberId: lead.id, roomRevision: room.revision,
    requestId: 'paired-reply', message: 'Paired device requests a reply' }) });
  assert.equal(response.status, 200);
  const afterPhone = await until(() => host.runtime.roomDetails(room.id), view => view.active === null);
  assert.equal(afterPhone.messages.at(-1)?.text, 'Answered with shared chat permission.', JSON.stringify(trace));
  const shared = await (await fetch(url, { headers })).json();
  assert.equal(shared.members[0].workspace, undefined);
  assert.equal(shared.members[1].workspace, undefined);
});

test('changing an existing member workspace interrupts its old messages and starts from the new directory', { timeout: 45_000 }, async t => {
  const entered = Promise.withResolvers<void>();
  const f = await scriptedFixture(async (context, signal) => {
    const last = context.messages.findLastIndex(message => message.role === 'user');
    const input = JSON.parse(String(context.messages[last]?.content));
    if (input.message === 'Hold this scoped turn') {
      entered.resolve();
      await setTimeout(60_000, undefined, { signal });
    }
    const read = context.messages.slice(last).find(message => message.role === 'toolResult' && message.toolName === 'read');
    if (!read) return call('read', { path: 'scope.txt' });
    assert.match(JSON.stringify(read), /NEW_ROOM_SCOPE_83/);
    return fauxAssistantMessage('Read from the new workspace.');
  });
  t.after(() => f.close());
  const project = join(f.directory, 'member-project'), first = join(project, 'first'), second = join(project, 'second');
  await mkdir(first, { recursive: true });
  await mkdir(second);
  await writeFile(join(project, '.kada-project'), '');
  await writeFile(join(second, 'scope.txt'), 'NEW_ROOM_SCOPE_83');
  const member = await f.runtime.assistants.create({ workspace: first, name: 'Scoped member', instructions: 'Review this workspace.', tools: ['read'] });
  const local = await f.runtime.assistants.create({ workspace: f.workspace, name: 'Local member', instructions: 'Reply to the room.', tools: [] });
  const localRef = { id: local.id, revision: local.revision };
  const scope = (workspace: string) => ({ id: member.id, revision: member.revision, workspace });
  const room = await f.runtime.createRoom({ title: 'Outbox', workspace: f.workspace, members: [scope(first), localRef] });
  const send = (requestId: string, message: string) => f.runtime.sendRoomMessage(room.id, { memberId: member.id, requestId, message });
  await send('held-scope', 'Hold this scoped turn');
  await entered.promise;
  assert.equal((await send('queued-scope', 'Queued under old scope')).status, 'queued');
  await f.runtime.updateRoom(room.id, { revision: room.revision, members: [scope(second), localRef] });
  assert.equal((await send('held-scope', 'Hold this scoped turn')).status, 'interrupted');
  assert.equal((await send('queued-scope', 'Queued under old scope')).status, 'interrupted');
  await send('next-scope', 'Read next project scope.');
  await until(() => f.runtime.roomDetails(room.id), view => view.messages.some(message => message.text === 'Read from the new workspace.'));
});
