import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { hasTool, scriptedFixture, until } from './helpers.js';

test('a room transfer keeps the owner-selected file bytes and restricts reads to fixed attachment IDs', async t => {
  let reviewerId = '', source = '';
  const f = await scriptedFixture(async context => {
    const input = JSON.parse(String(context.messages.findLast(message => message.role === 'user')?.content));
    assert.deepEqual(input.attachments.map((file: { id: number; name: string }) => [file.id, file.name]), [[1, 'source.txt']]);
    assert(!hasTool(context, 'read') && !hasTool(context, 'bash'));
    if (input.message === 'Pass the original file') {
      assert(!hasTool(context, 'room_read_file'));
      await writeFile(source, 'Later changed data.');
      return fauxAssistantMessage(fauxToolCall('room_handoff', { member_id: reviewerId, message: 'Read attachment one.' }), { stopReason: 'toolUse' });
    }
    assert(hasTool(context, 'room_read_file'));
    const output = context.messages.filter(message => message.role === 'toolResult' && message.toolName === 'room_read_file');
    if (!output.length) return fauxAssistantMessage(fauxToolCall('room_read_file', { id: 2 }), { stopReason: 'toolUse' });
    if (output.length === 1) {
      assert(output[0]!.isError);
      return fauxAssistantMessage(fauxToolCall('room_read_file', { id: 1 }), { stopReason: 'toolUse' });
    }
    assert(!output[1]!.isError);
    assert(JSON.stringify(output[1]!.content).includes('Original fixed data.'));
    assert(!JSON.stringify(output[1]!.content).includes('Later changed data.'));
    return fauxAssistantMessage('The original attachment was read.');
  });
  t.after(() => f.close());
  source = join(f.workspace, 'source.txt');
  await writeFile(source, 'Original fixed data.');
  const lead = await f.runtime.assistants.create({ workspace: f.workspace, name: 'Lead', instructions: 'Hand off the file.', tools: ['room_handoff'] });
  const reader = await f.runtime.assistants.create({ workspace: f.workspace, name: 'Reader', instructions: 'Read the authorized attachment.', tools: ['room_read_file'] });
  reviewerId = reader.id;
  const room = await f.runtime.createRoom({ workspace: f.workspace, title: 'Room files',
    members: [lead, reader].map(({ id, revision }) => ({ id, revision })) });
  const input = { memberId: lead.id, requestId: 'fixed-input', message: 'Pass the original file', files: ['source.txt'] };
  await assert.rejects(f.runtime.sendRoomMessage(room.id, { ...input, requestId: 'outside', files: ['../outside.txt'] }), /outside/i);
  await f.runtime.sendRoomMessage(room.id, input);
  const last = await until(() => f.runtime.roomDetails(room.id), view => view.active === null);
  assert.deepEqual(last.messages.map(message => message.role), ['user', 'handoff', 'assistant']);
  assert.equal(last.messages[2]!.text, 'The original attachment was read.');
  assert.equal(last.messages[0]!.attachments?.[0]?.name, 'source.txt');
  const published = await f.runtime.roomAttachment(room.id, last.messages[0]!.id, 1);
  assert.equal(await readFile(published.path, 'utf8'), 'Original fixed data.');
  await assert.rejects(f.runtime.roomAttachment(room.id, last.messages[0]!.id, 2), /not found/i);
  await writeFile(published.path, 'An edited fixed copy');
  await assert.rejects(f.runtime.roomAttachment(room.id, last.messages[0]!.id, 1), /changed/i);
  assert.equal((await f.runtime.sendRoomMessage(room.id, input)).answerEntryId, last.messages[2]?.id);
  assert.equal(await readFile(source, 'utf8'), 'Later changed data.');
});
