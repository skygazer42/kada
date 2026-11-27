import assert from 'node:assert/strict';
import test from 'node:test';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { hasTool, scriptedFixture, until } from './helpers.js';

test('the authorized room speaker hands off to one original member and only that member writes the final reply', async t => {
  let receiverId = '';
  const models: string[] = [];
  const f = await scriptedFixture(context => {
    const input = JSON.parse(String(context.messages.findLast(message => message.role === 'user')?.content));
    const prompt = JSON.stringify(context.messages);
    if (input.message === 'Please route the review') {
      assert(prompt.includes('ROOM_LEAD_PIN'));
      assert(hasTool(context, 'room_handoff'));
      assert(input.handoffMembers.some((member: { id: string }) => member.id === receiverId));
      models.push('lead');
      return fauxAssistantMessage(fauxToolCall('room_handoff', { member_id: receiverId, message: 'Review the shared summary' }), { stopReason: 'toolUse' });
    }
    assert.equal(input.message, 'Review the shared summary');
    assert.equal(input.originalMessage, 'Please route the review');
    assert(prompt.includes('ROOM_REVIEWER_PIN'));
    assert(!prompt.includes('ROOM_LEAD_PIN'));
    assert(!hasTool(context, 'room_handoff'));
    models.push('reviewer');
    return fauxAssistantMessage('Review completed in the original room');
  });
  t.after(() => f.close());
  const create = (name: string, instructions: string) => f.runtime.assistants.create({
    workspace: f.workspace, name, instructions, tools: ['room_handoff'],
  });
  const lead = await create('Lead', 'ROOM_LEAD_PIN');
  const reviewer = await create('Reviewer', 'ROOM_REVIEWER_PIN');
  receiverId = reviewer.id;
  const room = await f.runtime.createRoom({ workspace: f.workspace, title: 'Handoff room',
    members: [lead, reviewer].map(({ id, revision }) => ({ id, revision })) });
  const input = { memberId: lead.id, message: 'Please route the review', requestId: 'original-handoff' };
  await f.runtime.sendRoomMessage(room.id, input);
  const view = await until(() => f.runtime.roomDetails(room.id), state => state.active === null);
  assert.deepEqual(models, ['lead', 'reviewer']);
  assert.deepEqual(view.messages.map(event => event.role), ['user', 'handoff', 'assistant']);
  assert.equal(view.messages[1]?.memberId, lead.id);
  assert.equal(view.messages[1]?.toMemberId, reviewer.id);
  assert.equal(view.messages[2]?.memberId, reviewer.id);
  assert.equal(view.messages[2]?.text, 'Review completed in the original room');
  const receipt = await f.runtime.sendRoomMessage(room.id, input);
  assert.equal(receipt.answerEntryId, view.messages[2]?.id);
  assert.deepEqual(models, ['lead', 'reviewer']);
});

test('an original speaker cannot use a handoff to receive a fresh token budget', async t => {
  let calls = 0;
  const f = await scriptedFixture(context => {
    calls++;
    const input = JSON.parse(String(context.messages.findLast(message => message.role === 'user')?.content));
    assert.equal(calls, 1);
    return fauxAssistantMessage(fauxToolCall('room_handoff', { member_id: input.handoffMembers[0].id, message: 'Try to continue' }), { stopReason: 'toolUse' });
  }, { maxTotalTokens: 1 });
  t.after(() => f.close());
  const members = await Promise.all(['First', 'Second'].map(name => f.runtime.assistants.create({
    workspace: f.workspace, name, instructions: 'Budget test member', tools: ['room_handoff'],
  })));
  const room = await f.runtime.createRoom({ workspace: f.workspace, title: 'Limited room', members: members.map(({ id, revision }) => ({ id, revision })) });
  const input = { memberId: members[0]!.id, message: 'Use the original budget', requestId: 'budget' };
  await f.runtime.sendRoomMessage(room.id, input);
  const view = await until(() => f.runtime.roomDetails(room.id), value => value.active === null);
  assert.equal(view.messages[0]?.status, 'interrupted');
  assert.equal(view.messages.length, 1);
  assert.equal(calls, 1);
  await assert.rejects(f.runtime.sendRoomMessage(room.id, { ...input, requestId: 'new-budget' }), /token budget/i);
});
