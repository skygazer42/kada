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

test('an exhausted room budget settles queued messages and prevents another speaker', async t => {
  const originalMayFinish = Promise.withResolvers<void>();
  let calls = 0;
  const f = await scriptedFixture(async context => {
    calls++;
    const input = JSON.parse(String(context.messages.findLast(message => message.role === 'user')?.content));
    assert.equal(calls, 1);
    await originalMayFinish.promise;
    return fauxAssistantMessage(fauxToolCall('room_handoff', { member_id: input.handoffMembers[0].id, message: 'Try to continue' }), { stopReason: 'toolUse' });
  }, { maxTotalTokens: 1 });
  t.after(() => { originalMayFinish.resolve(); return f.close(); });
  const members = await Promise.all(['First', 'Second'].map(name => f.runtime.assistants.create({
    workspace: f.workspace, name, instructions: 'Budget test member', tools: ['room_handoff'],
  })));
  const room = await f.runtime.createRoom({ workspace: f.workspace, title: 'Limited room', members: members.map(({ id, revision }) => ({ id, revision })) });
  const input = { memberId: members[0]!.id, message: 'Use the original budget', requestId: 'budget' };
  await f.runtime.sendRoomMessage(room.id, input);
  const waiting = { memberId: members[1]!.id, message: 'Wait for the first member', requestId: 'waiting-budget' };
  const queued = await f.runtime.sendRoomMessage(room.id, waiting);
  assert.equal(queued.status, 'queued');
  originalMayFinish.resolve();
  const view = await until(() => f.runtime.roomDetails(room.id), value => value.active === null && value.messages[1]?.status === 'interrupted');
  assert.equal(view.messages[0]?.status, 'interrupted');
  assert.equal(view.messages.length, 2);
  assert.equal(calls, 1);
  assert.deepEqual(await f.runtime.sendRoomMessage(room.id, waiting), { ...queued, status: 'interrupted' });
  await assert.rejects(f.runtime.sendRoomMessage(room.id, { ...input, requestId: 'new-budget' }), /token budget/i);
});

test('three authorized members hand off in order without offering a visited member again', async t => {
  let ids: string[] = [];
  const seen: string[] = [];
  const f = await scriptedFixture(context => {
    const input = JSON.parse(String(context.messages.findLast(message => message.role === 'user')?.content));
    seen.push(input.message);
    if (input.message === 'Start original review') {
      assert.deepEqual(input.handoffMembers.map((member: { id: string }) => member.id), ids.slice(1));
      return fauxAssistantMessage(fauxToolCall('room_handoff', { member_id: ids[1], message: 'Check the source' }), { stopReason: 'toolUse' });
    }
    if (input.message === 'Check the source') {
      assert.equal(input.from, 'Lead');
      assert.equal(input.originalMessage, 'Start original review');
      assert(hasTool(context, 'room_handoff'));
      assert.deepEqual(input.handoffMembers.map((member: { id: string }) => member.id), [ids[2]]);
      return fauxAssistantMessage(fauxToolCall('room_handoff', { member_id: ids[2], message: 'Report the original result' }), { stopReason: 'toolUse' });
    }
    assert.equal(input.from, 'Reader');
    assert.equal(input.originalMessage, 'Start original review');
    assert(!hasTool(context, 'room_handoff'));
    return fauxAssistantMessage('The final room result.');
  });
  t.after(() => f.close());
  const members = await Promise.all(['Lead', 'Reader', 'Reviewer'].map(name => f.runtime.assistants.create({
    workspace: f.workspace, name, instructions: 'Only handle this room stage.', tools: ['room_handoff'],
  })));
  ids = members.map(member => member.id);
  const room = await f.runtime.createRoom({ workspace: f.workspace, title: 'Three member room', members: members.map(({ id, revision }) => ({ id, revision })) });
  const input = { memberId: ids[0], message: 'Start original review', requestId: 'original-chain' };
  await f.runtime.sendRoomMessage(room.id, input);
  const view = await until(() => f.runtime.roomDetails(room.id), state => state.active === null);
  assert.deepEqual(seen, ['Start original review', 'Check the source', 'Report the original result']);
  assert.deepEqual(view.messages.map(event => event.role), ['user', 'handoff', 'handoff', 'assistant']);
  assert.deepEqual(view.messages.filter(event => event.role === 'handoff').map(event => event.toMemberId), ids.slice(1));
  assert.equal(view.messages[3]?.memberId, ids[2]);
  assert.equal((await f.runtime.sendRoomMessage(room.id, input)).answerEntryId, view.messages[3]?.id);
});
