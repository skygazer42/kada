import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import { LocalRuntime } from '../src/runtime.js';
import { scriptedFixture, until } from './helpers.js';

test('removing a group member stops its original turn while preserving the transcript and receipts', async t => {
  const entered = Promise.withResolvers<void>();
  let stopped = false;
  const f = await scriptedFixture(async (context, signal) => {
    const input = JSON.parse(String(context.messages.findLast(message => message.role === 'user')?.content)) as { message: string };
    if (input.message === 'Hold the original room turn') {
      entered.resolve();
      try { await setTimeout(60_000, undefined, { signal }); }
      finally { stopped = signal?.aborted === true; }
    }
    const prompt = JSON.stringify(context.messages);
    assert(prompt.includes('REVISED_MEMBER_INSTRUCTIONS'));
    assert(!prompt.includes('INITIAL_MEMBER_INSTRUCTIONS'));
    return fauxAssistantMessage('Updated member reply');
  });
  let runtime = f.runtime;
  t.after(async () => { await runtime.close(); await f.close(); });
  const create = (name: string, instructions: string) => runtime.assistants.create({ workspace: f.workspace, name, instructions, tools: [] });
  const first = await create('First', 'INITIAL_MEMBER_INSTRUCTIONS');
  const second = await create('Second', 'Second member.');
  const third = await create('Third', 'Third member.');
  const ref = ({ id, revision }: { id: string; revision: number }) => ({ id, revision });
  const room = await runtime.createRoom({ workspace: f.workspace, title: 'Original room', members: [ref(first), ref(second)] });
  const input = { memberId: first.id, message: 'Hold the original room turn', requestId: 'stop-original' };
  const firstReceipt = await runtime.sendRoomMessage(room.id, input);
  await entered.promise;
  await assert.rejects(runtime.updateRoom(room.id, { revision: 99, members: [ref(second), ref(third)] }), /revision|changed/i);
  assert.equal((await runtime.roomDetails(room.id)).active?.requestId, input.requestId);
  const replacement = await runtime.updateRoom(room.id, { revision: 1, title: 'New room name', members: [ref(second), ref(third)] });
  assert.equal(replacement.revision, 2);
  assert.equal(replacement.title, 'New room name');
  assert.deepEqual(replacement.members.map(member => member.id), [second.id, third.id]);
  assert.equal(stopped, true);
  await assert.rejects(runtime.sendRoomMessage(room.id, { ...input, requestId: 'new-work' }), /member/i);
  assert.deepEqual(await runtime.sendRoomMessage(room.id, input), { ...firstReceipt, status: 'interrupted' });
  assert.deepEqual((await runtime.roomDetails(room.id)).messages.map(message => message.text), [input.message]);

  const revised = await runtime.assistants.update(first.id, { revision: first.revision, instructions: 'REVISED_MEMBER_INSTRUCTIONS' });
  const restored = await runtime.updateRoom(room.id, { revision: replacement.revision, members: [ref(revised), ref(second)] });
  await runtime.close();
  runtime = new LocalRuntime(f.settings, { models: f.models });
  await runtime.recover();
  const reloaded = await runtime.roomDetails(room.id);
  assert.equal(reloaded.revision, restored.revision);
  assert.equal(reloaded.members[0]!.revision, first.revision + 1);
  assert.equal(reloaded.title, 'New room name');
  await runtime.sendRoomMessage(room.id, { memberId: first.id, message: 'Check the new member', requestId: 'pin-revised-role' });
  const checked = await until(() => runtime.roomDetails(room.id), selected => selected.messages.length === 3);
  assert.equal(checked.messages[2]!.revision, revised.revision);
  assert.equal(checked.messages[2]!.text, 'Updated member reply');
});
