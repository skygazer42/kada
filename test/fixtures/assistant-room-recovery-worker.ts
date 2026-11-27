import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { defineDoc, type ConversationId } from '@earendil-works/pi-durable';
import { LocalRuntime } from '../../src/runtime.js';
import { until } from '../helpers.js';

const [phase, directory, mode] = process.argv.slice(2) as [string, string, string];
const workspace = join(directory, 'workspace');
const model = { provider: 'room-recovery', modelId: 'scripted' };
const provider = fauxProvider({ provider: model.provider, models: [{ id: model.modelId }] });
const generated = Promise.withResolvers<void>();
const originalMessage = 'Original topic', handoffMessage = 'Handle the original room topic';
const finalMessage = 'Finish the room chain', delegated = mode !== 'direct', chained = mode === 'chain';
let requests = 0;
provider.setResponses(Array.from({ length: 4 }, () => async (context, options) => {
  const message = context.messages.findLast(item => item.role === 'user');
  const input = JSON.parse(String(message?.content));
  if (delegated && input.message === originalMessage) {
    assert.equal(phase, 'create', 'Recovery must continue from the original recipient.');
    return fauxAssistantMessage(fauxToolCall('room_handoff', { member_id: input.handoffMembers[0].id, message: handoffMessage }), { stopReason: 'toolUse' });
  }
  if (chained && input.message === handoffMessage) {
    assert.equal(phase, 'create', 'Recovery must not rerun the intermediate room speaker.');
    return fauxAssistantMessage(fauxToolCall('room_handoff', { member_id: input.handoffMembers[0].id, message: finalMessage }), { stopReason: 'toolUse' });
  }
  assert.equal(input.message, chained ? finalMessage : delegated ? handoffMessage : originalMessage);
  requests++;
  generated.resolve();
  if (phase === 'create') await setTimeout(60_000, undefined, { signal: options?.signal });
  return fauxAssistantMessage('Original room answer after restart');
}));
const models = createModels();
models.setProvider(provider.provider);
const runtime = new LocalRuntime({ dataDir: directory, port: 4317, model, maxSubagents: 0, maxDurationMs: 120_000,
  web: false, review: false, discovery: false }, { models });
const requestId = 'original-room-message';

async function nativeSubmission(id: string) {
  const active = runtime['active'].get(id)!;
  const { items } = await active.storage.scanSubmissions({}, 20, undefined, ctx);
  const rows = items.filter(submission => submission.requestId === `room:${requestId}${chained ? ':handoff:2' : delegated ? ':handoff' : ''}`);
  assert.equal(rows.length, 1);
  return rows[0]!.id;
}

try {
  if (phase === 'create') {
    await mkdir(workspace);
    const read = await runtime.assistants.create({ workspace, name: 'Reader', instructions: 'Read.', tools: delegated ? ['room_handoff'] : [] });
    const write = await runtime.assistants.create({ workspace, name: 'Writer', instructions: 'Write.', tools: chained ? ['room_handoff'] : [] });
    const peers = [read, write];
    if (chained) peers.push(await runtime.assistants.create({ workspace, name: 'Reviewer', instructions: 'Review.', tools: [] }));
    const members = peers.map(({ id, revision }) => ({ id, revision }));
    const room = await runtime.createRoom({ title: 'Recovery', workspace, members });
    const receipt = await runtime.sendRoomMessage(room.id, { memberId: read.id, message: originalMessage, requestId });
    await generated.promise;
    if (mode === 'legacy') {
      type Speaker = { target: ConversationId; memberId: string; revision: number; name: string };
      const LegacyRoom = defineDoc<{ turns: Record<string, { current: Speaker; stage?: number; handoff?: { receiver: Speaker; message: string } }> }>({
        scope: 'session', kind: 'local.assistant_room', version: 1, initial: () => ({ turns: {} }), checkpointWhen: () => true,
      });
      await runtime['active'].get(room.id)!.harness.commit(async tx => {
        const turn = (await tx.doc(LegacyRoom)).turns['room:' + requestId]!;
        turn.handoff = { receiver: { ...turn.current }, message: handoffMessage };
        delete turn.stage;
      }, ctx);
    }
    console.log(JSON.stringify({ type: 'ready', submissionId: await nativeSubmission(room.id), messageEntryId: receipt.messageEntryId }));
    await setTimeout(60_000);
  } else {
    await runtime.recover();
    const [room] = await runtime.listRooms();
    assert(room);
    const view = await until(() => runtime.roomDetails(room.id), state => state.messages.length === (chained ? 4 : delegated ? 3 : 2));
    const submissionId = await nativeSubmission(room.id);
    const receipt = await runtime.sendRoomMessage(room.id, { memberId: room.members[0]!.id, message: originalMessage, requestId });
    console.log(JSON.stringify({ submissionId, receipt, messages: view.messages, requests }));
  }
} finally { await runtime.close(); }
