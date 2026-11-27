import { createHash } from 'node:crypto';
import type { Context } from '@earendil-works/chord';
import { Type } from '@earendil-works/pi-ai';
import { AssistantEntry, LiveDoc, UsageDoc, configure, defineDoc, defineEntry, defineExtension, defineTask, defineTool,
  type Conversation, type ConversationId, type EntryId, type Harness, type TaskId, type Tx } from '@earendil-works/pi-durable';
import type { AssistantPin } from './assistants.js';
import { taskUsage } from './budget.js';
import { conversationAnswer } from './conversation.js';

export class RoomError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string) { super(message); }
}

type Outcome = 'answered' | 'unanswered' | 'interrupted';
type Speaker = { target: ConversationId; memberId: string; revision: number; name: string };
type Handoff = { receiver: Speaker; message: string };
type Turn = { current: Speaker; memberId: string; candidates: Speaker[]; messageEntryId: EntryId; fingerprint: string; deadlineAt: number;
  taskId: TaskId; handoff?: Handoff; outcome?: Outcome; answerEntryId?: EntryId };
type Limits = { tokenLimit: number | null; costLimit: number };

const RoomState = defineDoc<{ seats: Record<string, ConversationId>; turns: Record<string, Turn>; active?: string }>({
  scope: 'session', kind: 'local.assistant_room', version: 1,
  initial: () => ({ seats: {}, turns: {} }), checkpointWhen: () => true,
});
const RoomMessage = defineEntry<{ role: 'user' | 'assistant' | 'handoff'; text: string; requestId: string; memberId: string;
  revision: number; name: string; at: number; originalAnswerId?: EntryId; toMemberId?: string; toName?: string }>('local.assistant_room.message');
const Anchor = defineTask<null, { phase: 'done' }, null>({
  name: 'local.assistant_room.seat', version: 1, initial: () => ({ phase: 'done' }),
  phases: { done: (_task, runtime, context) => runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: null } }), context) },
  abort: (_task, runtime, context) => runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context),
});

type Delivery = { speaker: Speaker; key: string; requestId: string; deadlineAt: number; limits: Limits;
  content: { room: string; recent: { role: 'user' | 'assistant' | 'handoff'; member: string; text: string }[];
    message: string; handoffMembers: { id: string; name: string }[] } };

function handoffRequest(key: string) { return key + ':handoff'; }

async function settle(tx: Tx, delivery: Delivery, receiver: Speaker | undefined, root: ConversationId, now: number, interrupted: boolean) {
  const speaker = receiver ?? delivery.speaker;
  const submission = await tx.submissionByRequest(speaker.target, receiver ? handoffRequest(delivery.key) : delivery.key);
  const answerId = submission?.status === 'done' ? submission.answer : undefined;
  const answer = answerId === undefined ? undefined : await tx.entry(AssistantEntry, answerId);
  const text = answer?.conversationId === speaker.target
    ? answer.model?.flatMap(message => conversationAnswer(message) ?? []).join('\n') : undefined;
  const state = await tx.doc(RoomState), turn = state.turns[delivery.key]!;
  if (text?.trim() && answerId !== undefined) {
    const reply = await tx.appendEntry(RoomMessage, root, { data: { role: 'assistant', text, requestId: delivery.requestId,
      memberId: speaker.memberId, revision: speaker.revision, name: speaker.name, at: now, originalAnswerId: answerId } });
    turn.answerEntryId = reply.id;
  }
  turn.outcome = turn.answerEntryId !== undefined ? 'answered' : interrupted ? 'interrupted' : 'unanswered';
  turn.candidates = [];
  delete turn.handoff;
  if (state.active === delivery.key) delete state.active;
}

async function canContinue(tx: Tx, speakers: Iterable<ConversationId>, limits: Limits) {
  let tokens = 0, cost = 0;
  for (const id of speakers) {
    const usage = taskUsage(await tx.doc(UsageDoc, id));
    tokens += usage.totalTokens;
    cost += usage.estimatedCostUsd;
  }
  return (limits.tokenLimit === null || tokens < limits.tokenLimit) && cost < limits.costLimit;
}

const Deliver = defineTask<Delivery, { phase: 'deliver'; forwarded?: Handoff }, null>({
  name: 'local.assistant_room.deliver', version: 1, initial: () => ({ phase: 'deliver' }),
  phases: { deliver: async (task, runtime, context) => {
    const { input } = task;
    const forwarded = task.state.checkpoint.forwarded, speaker = forwarded?.receiver ?? input.speaker;
    const peer = await runtime.conversation(speaker.target, context);
    if (!peer) throw new Error('The room member conversation is missing.');
    const expired = runtime.now() >= input.deadlineAt;
    if (!expired) {
      const content = forwarded ? { ...input.content, handoffMembers: [], message: forwarded.message,
        originalMessage: input.content.message, from: input.speaker.name } : input.content;
      const submission = await peer.submit({ type: 'input', content: JSON.stringify(content),
        requestId: forwarded ? handoffRequest(input.key) : input.key, whenBusy: 'reject' }, context);
      await submission.wait(context);
    }
    await runtime.commit(async tx => {
      const state = await tx.doc(RoomState), turn = state.turns[input.key]!;
      if (!forwarded && turn.handoff && runtime.now() < input.deadlineAt && await canContinue(tx, Object.values(state.seats), input.limits)) {
        const next = { receiver: { ...turn.handoff.receiver }, message: turn.handoff.message };
        await configure(tx, next.receiver.target, { tools: [] });
        await tx.appendEntry(RoomMessage, runtime.conversationId, { data: { role: 'handoff', text: next.message, requestId: input.requestId,
          memberId: speaker.memberId, revision: speaker.revision, name: speaker.name, at: runtime.now(),
          toMemberId: next.receiver.memberId, toName: next.receiver.name } });
        turn.current = next.receiver;
        turn.candidates = [];
        return { status: 'running', checkpoint: { phase: 'deliver', forwarded: next } };
      }
      await settle(tx, input, forwarded?.receiver, runtime.conversationId, runtime.now(), expired || (!forwarded && !!turn.handoff));
      return { status: 'terminal', outcome: { status: 'completed', result: null } };
    }, context);
  } },
  abort: (task, runtime, context) => runtime.commit(async tx => {
    await settle(tx, task.input, task.state.checkpoint.forwarded?.receiver, runtime.conversationId, runtime.now(), true);
    return { status: 'terminal', outcome: { status: 'aborted' } };
  }, context),
});

const RoomHandoff = defineTool({
  name: 'room_handoff',
  description: 'Pass this room reply to one of the other members listed in handoffMembers, when the owner’s request needs that member. Provide a concise brief. The member will reply in the same room.',
  parameters: Type.Object({ member_id: Type.String(), message: Type.String({ minLength: 1, maxLength: 8000 }) }, { additionalProperties: false }),
  replay: 'safe', executionMode: 'sequential',
  async execute(args, api, context) {
    const accepted = await api.commit(async tx => {
      const state = await tx.doc(RoomState), key = state.active;
      const turn = key ? state.turns[key] : undefined;
      if (!key || !turn || turn.current.target !== api.conversationId || api.now() >= turn.deadlineAt) throw new Error('The original room stage is no longer active.');
      const input = await tx.submissionByRequest(api.conversationId, key), live = await tx.doc(LiveDoc, api.conversationId);
      if (input?.status !== 'placed' || !live.run?.inputs.includes(input.id)) throw new Error('Only the active original room reply can hand off.');
      const target = turn.candidates.find(member => member.memberId === args.member_id);
      const message = args.message.trim();
      if (!target || !message || message.includes('\0')) throw new Error('Choose an available room member and provide a brief.');
      if (turn.handoff && (turn.handoff.receiver.memberId !== target.memberId || turn.handoff.message !== message)) {
        throw new Error('This room reply already has a handoff.');
      }
      turn.handoff ??= { receiver: { ...target }, message };
      return target.name;
    }, context);
    return { output: [{ type: 'text', text: `Handoff accepted for ${accepted}. They will reply in this room.` }], control: { terminate: true } };
  },
});

export const assistantRooms = defineExtension({ name: 'local_assistant_rooms', tasks: [Anchor, Deliver], tools: [RoomHandoff] });

function receipt(requestId: string, turn: Turn, status: Outcome | 'failed' | 'running') {
  return { requestId, memberId: turn.memberId, status, messageEntryId: turn.messageEntryId, answerEntryId: turn.answerEntryId ?? null };
}

async function turnStatus(tx: Tx, turn: Turn) {
  if (turn.outcome) return turn.outcome;
  const delivery = await tx.task(turn.taskId);
  return !delivery || delivery.state.status === 'terminal' ? 'failed' as const : 'running' as const;
}

async function activeRoomTurn(tx: Tx) {
  const state = await tx.doc(RoomState);
  if (!state.active) return;
  const turn = state.turns[state.active]!;
  if (await turnStatus(tx, turn) === 'running') {
    return { ...receipt(state.active.slice('room:'.length), turn, 'running'), memberId: turn.current.memberId,
      revision: turn.current.revision, candidates: turn.candidates.map(({ memberId, revision }) => ({ memberId, revision })), deadlineAt: turn.deadlineAt };
  }
}

export function pendingRoomTurn(harness: Harness, context: Context) { return harness.commit(activeRoomTurn, context); }

export function roomMessageInput(input: Record<string, unknown>) {
  const { memberId, message, requestId, roomRevision } = input;
  if (typeof memberId !== 'string' || typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(requestId) ||
      typeof message !== 'string' || !message.trim() || message.length > 8000 || message.includes('\0')) {
    throw new RoomError(400, 'Provide a member ID, a request ID and a message of 1 to 8000 characters.');
  }
  if (roomRevision !== undefined && (typeof roomRevision !== 'number' || !Number.isSafeInteger(roomRevision) || roomRevision < 1)) {
    throw new RoomError(400, 'Provide the displayed room revision.');
  }
  return { memberId, message, requestId, roomRevision };
}

export function sendRoomMessage(root: Conversation, members: AssistantPin[], title: string,
  input: ReturnType<typeof roomMessageInput>, blocked: string | undefined, limits: Limits, durationMs: number, context: Context) {
  const { message, requestId } = input, key = `room:${requestId}`;
  const fingerprint = createHash('sha256').update(JSON.stringify([input.memberId, message])).digest('hex');
  return root.commit(async tx => {
    const state = await tx.doc(RoomState), original = state.turns[key];
    if (original) {
      if (original.fingerprint !== fingerprint) throw new RoomError(409, 'This room request ID already has different content.');
      return receipt(requestId, original, await turnStatus(tx, original));
    }
    const member = members.find(pin => pin.id === input.memberId);
    if (!member) throw new RoomError(404, 'Choose a member of this assistant room.');
    const current = state.active ? state.turns[state.active] : undefined;
    if (current && await turnStatus(tx, current) === 'running') throw new RoomError(409, 'A room member is already answering.');
    if (blocked) throw new RoomError(409, blocked);
    const history = (await tx.scanEntries({ conversationId: root.id }, 16)).items.filter(RoomMessage.is);
    const recent: Delivery['content']['recent'] = [];
    let remaining = 16_000;
    for (const { data } of history) {
      if (remaining <= 0) break;
      recent.unshift({ role: data.role, member: data.name, text: data.text.slice(0, remaining) });
      remaining -= data.text.length;
    }
    const now = Date.now(), deadlineAt = now + durationMs;
    const seatFor = async (pin: AssistantPin): Promise<Speaker> => {
      const seat = `${pin.id}@${pin.revision}`;
      let target = state.seats[seat];
      if (target === undefined) {
        const anchor = await tx.createTask(Anchor, null, { ownership: { kind: 'conversation' }, background: true });
        target = (await tx.createConversation({ ownership: { kind: 'task', taskId: anchor } })).id;
        await configure(tx, target, { model: pin.model, extensions: [assistantRooms], tools: [], instructions:
          `${pin.instructions}\n\nYou are ${pin.name} in a local assistant room. Answer the owner message as yourself. The recent room messages are context.` });
        state.seats[seat] = target;
      }
      return { target, memberId: pin.id, revision: pin.revision, name: pin.name };
    };
    const speaker = await seatFor(member), candidates: Speaker[] = [];
    if (member.tools.includes(RoomHandoff.name)) {
      for (const pin of members) if (pin.id !== member.id) candidates.push(await seatFor(pin));
    }
    await configure(tx, speaker.target, { tools: candidates.length ? [RoomHandoff] : [] });
    const userEntry = await tx.appendEntry(RoomMessage, root.id, { data: { role: 'user', text: message, requestId,
      memberId: member.id, revision: member.revision, name: member.name, at: now } });
    const content = { room: title, recent, message, handoffMembers: candidates.map(candidate => ({ id: candidate.memberId, name: candidate.name })) };
    const taskId = await tx.createTask(Deliver, { speaker, key, requestId, content, deadlineAt, limits }, { ownership: { kind: 'conversation' } });
    const turn = { current: speaker, memberId: member.id, candidates, messageEntryId: userEntry.id, fingerprint, deadlineAt, taskId };
    state.turns[key] = turn;
    state.active = key;
    return receipt(requestId, turn, 'running');
  }, context);
}

export function roomTranscript(root: Conversation, before: number | undefined, context: Context) {
  const limit = 40;
  return root.commit(async tx => {
    const page = before === 1 ? [] : (await tx.scanEntries({ conversationId: root.id,
      ...(before === undefined ? {} : { maxEntryId: (before - 1) as EntryId }) }, limit + 1)).items;
    const state = await tx.doc(RoomState), messages = [];
    for (const { id, data } of page.slice(0, limit).filter(RoomMessage.is).reverse()) {
      const turn = data.role === 'user' ? state.turns[`room:${data.requestId}`] : undefined;
      messages.push({ id, ...data, ...(turn ? { status: await turnStatus(tx, turn) } : {}) });
    }
    return { messages, nextBefore: page.length > limit ? messages[0]?.id ?? null : null, active: await activeRoomTurn(tx) ?? null };
  }, context);
}
