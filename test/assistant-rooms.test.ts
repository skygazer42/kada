import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { promisify } from 'node:util';
import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import { createClient } from '../src/client.js';
import { LocalRuntime } from '../src/runtime.js';
import { serve } from '../src/server.js';
import { hasTool, recoveryTestTimeoutMs, scriptedFixture, startRecoveryWorker, until } from './helpers.js';

test('a local room routes an addressed message, preserves its receipt and shares only its public transcript', async t => {
  let releaseFirst!: () => void;
  const firstCanFinish = new Promise<void>(resolve => { releaseFirst = resolve; });
  let started = false;
  const requests: string[] = [];
  const f = await scriptedFixture(async context => {
    const input = String(context.messages.findLast(message => message.role === 'user')?.content);
    const transcript = JSON.stringify(context.messages);
    if (input === 'Independent private message') return fauxAssistantMessage('Private result');
    requests.push(input);
    assert(!hasTool(context, 'bash'));
    assert(!hasTool(context, 'assistant_assign'));
    assert(!hasTool(context, 'room_handoff'));
    assert(!transcript.includes('Independent private message'));
    const roomInput = JSON.parse(input) as { message: string };
    if (roomInput.message === 'First topic') {
      assert(transcript.includes('READER_ROLE_MARKER'));
      assert(!transcript.includes('WRITER_ROLE_MARKER'));
      if (!started) { started = true; await firstCanFinish; }
      return fauxAssistantMessage('Public first answer');
    }
    assert(transcript.includes('WRITER_ROLE_MARKER'));
    assert(!transcript.includes('READER_ROLE_MARKER'));
    assert(input.includes('Public first answer'));
    return fauxAssistantMessage('Public second answer');
  });
  let runtime = f.runtime;
  t.after(async () => { releaseFirst(); await runtime.close(); await f.close(); });
  const reader = await runtime.assistants.create({ workspace: f.workspace, name: 'Reader', instructions: 'READER_ROLE_MARKER', tools: ['read'] });
  const writer = await runtime.assistants.create({ workspace: f.workspace, name: 'Writer', instructions: 'WRITER_ROLE_MARKER', tools: ['bash'] });
  const readerRef = { id: reader.id, revision: reader.revision }, writerRef = { id: writer.id, revision: writer.revision };
  const separate = await runtime.create('Independent private message', f.workspace, [], { chat: true, assistant: readerRef });
  await until(() => runtime.status(separate.id), value => value.status === 'answered');
  await assert.rejects(runtime.createRoom({ workspace: f.workspace, title: 'Duplicates', members: [readerRef, readerRef] }), /distinct/i);
  const otherWorkspace = await mkdtemp(join(f.workspace, 'other-project-'));
  t.after(() => rm(otherWorkspace, { recursive: true, force: true }));
  await assert.rejects(runtime.createRoom({ workspace: otherWorkspace, title: 'Outside project', members: [readerRef, writerRef] }), /this project/i);
  const room = await runtime.createRoom({ workspace: f.workspace, title: 'Review room', members: [readerRef, writerRef] });
  assert.deepEqual((await runtime.listRooms()).map(item => item.id), [room.id]);
  assert.deepEqual((await runtime.roomDetails(room.id)).messages, []);
  assert.equal(requests.length, 0);
  await assert.rejects(runtime.followUp(room.id, 'Bypass group routing'), /room/i);
  const first = { memberId: reader.id, message: 'First topic', requestId: 'first' };
  await assert.rejects(runtime.sendRoomMessage(room.id, { ...first, memberId: room.id }), /member/i);
  const accepted = await runtime.sendRoomMessage(room.id, first);
  assert.equal(accepted.status, 'running');
  await until(async () => started, Boolean);
  assert.deepEqual(await runtime.sendRoomMessage(room.id, first), accepted);
  await assert.rejects(runtime.sendRoomMessage(room.id, { ...first, message: 'Different' }), /request ID/i);
  await assert.rejects(runtime.sendRoomMessage(room.id, { ...first, memberId: writer.id, requestId: 'concurrent' }), /already answering/i);
  releaseFirst();
  const initial = await until(() => runtime.roomDetails(room.id), value => value.messages.length === 2);
  assert.equal(initial.messages[1]!.text, 'Public first answer');
  assert.equal(initial.messages[1]!.memberId, reader.id);
  const settled = await runtime.sendRoomMessage(room.id, first);
  assert.equal(settled.status, 'answered');
  assert.equal(settled.answerEntryId, initial.messages[1]!.id);

  await runtime.assistants.update(writer.id, { revision: writer.revision, instructions: 'CHANGED_ROLE_MARKER' });
  await runtime.close();
  runtime = new LocalRuntime(f.settings, { models: f.models });
  await runtime.recover();
  assert.deepEqual(await runtime.sendRoomMessage(room.id, first), settled);
  assert.equal(requests.length, 1);
  await runtime.sendRoomMessage(room.id, { memberId: writer.id, message: 'Second topic', requestId: 'second' });
  const continued = await until(() => runtime.roomDetails(room.id), value => value.messages.length === 4);
  assert.equal(requests.length, 2);
  assert.equal(continued.messages[3]!.text, 'Public second answer');
  assert.equal(continued.messages[3]!.revision, writer.revision);
  assert.deepEqual((await runtime.roomDetails(room.id, continued.messages[2]!.id)).messages, initial.messages);
});

test('the terminal and authenticated API use the original room, outside its ordinary thread list', async t => {
  const f = await scriptedFixture(() => fauxAssistantMessage('Terminal group answer'));
  await f.runtime.close();
  const socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const config = { ...f.settings, port };
  const server = await serve(config, { models: f.models });
  t.after(async () => { await server.close(); await f.close(); });
  const client = createClient(config);
  const file = join(f.directory, 'room-test-config.json');
  await writeFile(file, JSON.stringify(config));
  const command = async (...args: string[]) => JSON.parse((await promisify(execFile)(process.execPath,
    ['--import', 'tsx', 'src/cli.ts', '--config', file, 'rooms', ...args])).stdout);
  const read = await server.runtime.assistants.create({ workspace: f.workspace, name: 'Review', instructions: 'Review.', tools: [] });
  const build = await server.runtime.assistants.create({ workspace: f.workspace, name: 'Build', instructions: 'Build.', tools: [] });
  const path = '/v1/assistant-rooms';
  assert.equal((await fetch(`http://127.0.0.1:${port}${path}`)).status, 401);
  const room = await command('add', 'Terminal room', `${read.id}@1`, `${build.id}@1`, '--workspace', f.workspace);
  assert.equal((await command('list'))[0].id, room.id);
  assert.deepEqual(await client.request('/v1/tasks'), []);
  const phone = await client.request<{ token: string }>('/v1/remote/devices', 'POST', { accountId: 'owner', deviceId: 'phone' });
  assert.equal((await fetch(`http://127.0.0.1:${port}${path}/${room.id}`, { headers: { Authorization: `Bearer ${phone.token}` } })).status, 401);
  await assert.rejects(client.request(`/v1/tasks/${room.id}/share-thread`, 'POST', { accountId: 'owner', deviceId: 'phone' }), /local host/i);
  await writeFile(join(f.workspace, 'terminal-note.txt'), 'Another room file');
  const send = await command('send', room.id, build.id, 'Addressed by terminal', 'original-terminal', '--room-file', 'terminal-note.txt');
  assert.equal(send.memberId, build.id);
  const view = await until(() => server.runtime.roomDetails(room.id), value => value.messages.length === 2);
  assert.equal(view.messages[1]?.text, 'Terminal group answer');
  assert.deepEqual(view.messages[0]?.attachments, [{ id: 1, name: 'terminal-note.txt', bytes: 17 }]);
  const fixed = await command('file', room.id, String(view.messages[0]!.id), '1');
  assert.equal(await readFile(fixed.path, 'utf8'), 'Another room file');
  assert.deepEqual((await command('show', room.id)).messages, view.messages);
  const edit = join(f.directory, 'room-edit.json');
  await writeFile(edit, JSON.stringify({ revision: room.revision, title: 'Renamed terminal room' }));
  assert.equal((await command('edit', room.id, edit)).title, 'Renamed terminal room');
  const duplicate = await client.request(`${path}/${room.id}/messages`, 'POST', {
    memberId: build.id, message: 'Addressed by terminal', requestId: 'original-terminal', files: ['terminal-note.txt'],
  });
  assert.deepEqual(duplicate, { ...send, status: 'answered', answerEntryId: view.messages[1]?.id });
});

for (const mode of ['direct', 'handoff', 'chain', 'legacy'] as const) {
  test(`SIGKILL during a ${mode} room reply preserves its native submission and one answer`, { timeout: recoveryTestTimeoutMs }, async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'kada-assistant-room-')));
    const fixture = new URL('./fixtures/assistant-room-recovery-worker.ts', import.meta.url);
    let worker = startRecoveryWorker(fixture, 'create', directory, mode);
    try {
      const started = await worker.ready();
      assert.equal(await worker.stop(), 'SIGKILL');
      worker = startRecoveryWorker(fixture, 'recover', directory, mode);
      const recovered = await worker.complete();
      assert.equal(recovered.submissionId, started.submissionId);
      assert.equal(recovered.receipt.messageEntryId, started.messageEntryId);
      assert.equal(recovered.receipt.status, 'answered');
      assert.equal(recovered.receipt.answerEntryId, recovered.messages.at(-1).id);
      assert.deepEqual(recovered.messages.map((message: { role: string }) => message.role),
        ['user', ...Array.from({ length: { direct: 0, handoff: 1, chain: 2, legacy: 1 }[mode] }, () => 'handoff'), 'assistant']);
      assert.equal(recovered.messages.at(-1).text, 'Original room answer after restart');
      assert.equal(recovered.requests, 1);
    } finally { await worker.stop(); await rm(directory, { recursive: true, force: true, maxRetries: 5 }); }
  });
}

test('a timed-out room answer settles before another member can start', async t => {
  let interrupted = false;
  const f = await scriptedFixture(async (context, signal) => {
    const content = context.messages.findLast(message => message.role === 'user')?.content;
    if (JSON.parse(String(content)).message === 'Slow room turn') {
      try { await setTimeout(60_000, undefined, { signal }); }
      finally { interrupted = signal?.aborted === true; }
    }
    return fauxAssistantMessage('Next member answered');
  }, { maxDurationMs: 1400 });
  t.after(() => f.close());
  const r = f.runtime;
  const first = await r.assistants.create({ workspace: f.workspace, name: 'First', instructions: 'First member.', tools: [] });
  const second = await r.assistants.create({ workspace: f.workspace, name: 'Second', instructions: 'Second member.', tools: [] });
  const room = await r.createRoom({ workspace: f.workspace, title: 'Timeout room',
    members: [first, second].map(({ id, revision }) => ({ id, revision })) });
  const input = { memberId: first.id, message: 'Slow room turn', requestId: 'original-timeout' };
  const original = await r.sendRoomMessage(room.id, input);
  const stopped = await until(() => r.roomDetails(room.id), value => value.active === null);
  assert.equal(interrupted, true);
  assert.equal(stopped.messages[0]?.status, 'interrupted');
  assert.deepEqual(await r.sendRoomMessage(room.id, input), { ...original, status: 'interrupted' });
  await r.sendRoomMessage(room.id, { memberId: second.id, message: 'Continue after timeout', requestId: 'next-turn' });
  const later = await until(() => r.roomDetails(room.id), value => value.messages.length === 3);
  assert.equal(later.messages[2]?.text, 'Next member answered');
});
