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

test('a role can publish a text attachment to the original room and hand its bytes to the next speaker', async t => {
  let reviewerId = '';
  const f = await scriptedFixture(context => {
    const input = JSON.parse(String(context.messages.findLast(message => message.role === 'user')?.content));
    const outputs = context.messages.filter(message => message.role === 'toolResult' && !message.isError);
    if (input.message === 'Produce the room findings') {
      assert(hasTool(context, 'room_attach_text'));
      return fauxAssistantMessage(outputs.some(message => message.toolName === 'room_attach_text')
        ? fauxToolCall('room_handoff', { member_id: reviewerId, message: 'Review the published attachment.' })
        : fauxToolCall('room_attach_text', { name: 'findings.txt', text: 'Exact published result.' }), { stopReason: 'toolUse' });
    }
    assert.equal(input.attachments[0].name, 'findings.txt');
    assert(!hasTool(context, 'room_attach_text'));
    const read = outputs.find(message => message.toolName === 'room_read_file');
    if (!read) return fauxAssistantMessage(fauxToolCall('room_read_file', { id: 1 }), { stopReason: 'toolUse' });
    assert(JSON.stringify(read.content).includes('Exact published result.'));
    return fauxAssistantMessage('Reviewed the published artifact.');
  });
  t.after(() => f.close());
  const lead = await f.runtime.assistants.create({ workspace: f.workspace, name: 'Author', instructions: 'Publish the attachment.', tools: ['room_attach_text', 'room_handoff'] });
  const reviewer = await f.runtime.assistants.create({ workspace: f.workspace, name: 'Reader', instructions: 'Inspect the artifact.', tools: ['room_read_file'] });
  reviewerId = reviewer.id;
  const room = await f.runtime.createRoom({ workspace: f.workspace, title: 'Room outputs',
    members: [lead, reviewer].map(({ id, revision }) => ({ id, revision })) });
  const input = { memberId: lead.id, requestId: 'room-output', message: 'Produce the room findings' };
  await f.runtime.sendRoomMessage(room.id, input);
  const view = await until(() => f.runtime.roomDetails(room.id), row => row.active === null);
  assert.deepEqual(view.messages.map(message => message.role), ['user', 'attachment', 'handoff', 'assistant']);
  assert.equal(view.messages[1]?.memberId, lead.id);
  assert.equal(view.messages[3]?.text, 'Reviewed the published artifact.');
  const saved = await f.runtime.roomAttachment(room.id, view.messages[1]!.id, 1);
  assert.equal(await readFile(saved.path, 'utf8'), 'Exact published result.');
  await assert.rejects(f.runtime.roomAttachment(room.id, view.messages[0]!.id, 1), /not found/i);
});
