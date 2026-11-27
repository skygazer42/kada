import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import type { Context } from '@earendil-works/chord';
import { Type } from '@earendil-works/pi-ai';
import { AgentDoc, AssistantEntry, LiveDoc, ROOT_CONVERSATION_ID, UsageDoc, configure, defineDoc, defineEntry, defineExtension, defineTask, defineTool, wrapTool,
  type Conversation, type ConversationId, type EntryId, type Harness, type TaskId, type ToolExecutionApi, type ToolRegistration, type Tx } from '@earendil-works/pi-durable';
import { createEditTool, createReadTool, createWriteTool } from '@earendil-works/pi-durable/tools';
import type { AssistantCollaboratorPin } from './assistants.js';
import { copyAssistantFiles, prepareAssistantFiles, publishAssistantBytes, type AssistantFile } from './assistant-files.js';
import { taskUsage } from './budget.js';
import { conversationAnswer } from './conversation.js';
import { nativeFileTools, scopedNativeFileArguments } from './remote-policy.js';
import { Workspace } from './workspace.js';

export class RoomError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string) { super(message); }
}

type Outcome = 'answered' | 'unanswered' | 'interrupted';
type Speaker = { target: ConversationId; memberId: string; revision: number; name: string;
  workspace?: string; fileTools?: string[]; canForward?: true; canReadFile?: true;
  canAttachText?: true; canAttachFile?: true; canSaveFile?: true };
type Attachment = { id: number; name: string; bytes: number };
type Handoff = { receiver: Speaker; message: string };
type Forwarded = Handoff & { stage?: number; from?: string; handoffMembers?: { id: string; name: string }[]; attachments?: Attachment[] };
type Turn = { current: Speaker; memberId: string; candidates: Speaker[]; messageEntryId: EntryId; fingerprint: string; deadlineAt?: number;
  taskId?: TaskId; stage?: number; fileWorkId?: string; attachments?: AssistantFile[]; publications?: Record<string, Attachment>;
  handoff?: Handoff; outcome?: Outcome; answerEntryId?: EntryId };
type Limits = { tokenLimit: number | null; costLimit: number };
type RoomExecution = { members: AssistantCollaboratorPin[]; title: string; limits: Limits; durationMs: number };

const roomQueueLimit = 8;
const roomAttachmentLimit = 1024 * 1024;
const roomNativeTools: ToolRegistration[] = [createReadTool(), createWriteTool(), createEditTool()];
function memberKey(id: string, revision: number, workspace?: string) {
  const version = id + '@' + revision;
  return workspace === undefined ? version : version + ':' + createHash('sha256').update(workspace).digest('hex');
}
const copySpeaker = (speaker: Speaker): Speaker => ({
  ...speaker, ...(speaker.fileTools ? { fileTools: [...speaker.fileTools] } : {}),
});
const RoomState = defineDoc<{ seats: Record<string, ConversationId>; turns: Record<string, Turn>; active?: string; queued?: string[] }>({
  scope: 'session', kind: 'local.assistant_room', version: 1,
  initial: () => ({ seats: {}, turns: {} }), checkpointWhen: () => true,
});
const RoomMessage = defineEntry<{ role: 'user' | 'assistant' | 'handoff' | 'attachment'; text: string; requestId: string; memberId: string;
  revision: number; name: string; at: number; originalAnswerId?: EntryId; toMemberId?: string; toName?: string;
  attachments?: Attachment[] }>('local.assistant_room.message');
const Anchor = defineTask<null, { phase: 'done' }, null>({
  name: 'local.assistant_room.seat', version: 1, initial: () => ({ phase: 'done' }),
  phases: { done: (_task, runtime, context) => runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: null } }), context) },
  abort: (_task, runtime, context) => runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context),
});

type Delivery = { speaker: Speaker; key: string; requestId: string; deadlineAt: number; limits: Limits;
  content: { room: string; recent: { role: 'user' | 'assistant' | 'handoff' | 'attachment'; member: string; text: string }[];
    message: string; handoffMembers: { id: string; name: string }[]; attachments?: Attachment[] } };

function stageRequest(key: string, stage: number) {
  if (stage === 0) return key;
  return stage === 1 ? key + ':handoff' : key + ':handoff:' + stage;
}

function stageOf(forwarded?: Forwarded) { return forwarded ? forwarded.stage ?? 1 : 0; }

async function settle(tx: Tx, delivery: Delivery, forwarded: Forwarded | undefined, root: ConversationId, now: number, interrupted: boolean) {
  const speaker = forwarded?.receiver ?? delivery.speaker;
  const submission = await tx.submissionByRequest(speaker.target, stageRequest(delivery.key, stageOf(forwarded)));
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

const Deliver = defineTask<Delivery, { phase: 'deliver'; forwarded?: Forwarded }, null>({
  name: 'local.assistant_room.deliver', version: 1, initial: () => ({ phase: 'deliver' }),
  phases: { deliver: async (task, runtime, context) => {
    const { input } = task;
    const forwarded = task.state.checkpoint.forwarded, speaker = forwarded?.receiver ?? input.speaker;
    const stage = stageOf(forwarded);
    const peer = await runtime.conversation(speaker.target, context);
    if (!peer) throw new Error('The room member conversation is missing.');
    const expired = runtime.now() >= input.deadlineAt;
    if (!expired) {
      const content = forwarded ? { ...input.content, handoffMembers: forwarded.handoffMembers ?? [], message: forwarded.message,
        ...(forwarded.attachments ? { attachments: forwarded.attachments } : {}),
        originalMessage: input.content.message, from: forwarded.from ?? input.speaker.name } : input.content;
      const submission = await peer.submit({ type: 'input', content: JSON.stringify(content),
        requestId: stageRequest(input.key, stage), whenBusy: 'reject' }, context);
      await submission.wait(context);
    }
    await runtime.commit(async tx => {
      const state = await tx.doc(RoomState), turn = state.turns[input.key]!;
      const accepted = turn.handoff;
      // Earlier versions kept a finished handoff on the record after dispatch.
      const handoff = accepted && turn.candidates.some(member => member.target === accepted.receiver.target) ? accepted : undefined;
      if (handoff && runtime.now() < input.deadlineAt && await canContinue(tx, Object.values(state.seats), input.limits)) {
        const receiver = copySpeaker(handoff.receiver);
        const remaining = receiver.canForward
          ? turn.candidates.filter(member => member.memberId !== receiver.memberId).map(copySpeaker) : [];
        const next: Forwarded = { receiver, message: handoff.message, stage: stage + 1, from: speaker.name,
          ...(turn.attachments?.length ? { attachments: describeAttachments(turn.attachments) } : {}),
          handoffMembers: remaining.map(member => ({ id: member.memberId, name: member.name })) };
        await configure(tx, receiver.target, { tools: speakerTools(receiver, remaining, turn.attachments ?? []) });
        await tx.appendEntry(RoomMessage, runtime.conversationId, { data: { role: 'handoff', text: next.message, requestId: input.requestId,
          memberId: speaker.memberId, revision: speaker.revision, name: speaker.name, at: runtime.now(),
          toMemberId: next.receiver.memberId, toName: next.receiver.name } });
        turn.current = receiver;
        turn.stage = stage + 1;
        turn.candidates = remaining;
        delete turn.handoff;
        return { status: 'running', checkpoint: { phase: 'deliver', forwarded: next } };
      }
      await settle(tx, input, forwarded, runtime.conversationId, runtime.now(), expired || !!handoff);
      return { status: 'terminal', outcome: { status: 'completed', result: null } };
    }, context);
  } },
  abort: (task, runtime, context) => runtime.commit(async tx => {
    await settle(tx, task.input, task.state.checkpoint.forwarded, runtime.conversationId, runtime.now(), true);
    return { status: 'terminal', outcome: { status: 'aborted' } };
  }, context),
});

async function currentStage(tx: Tx, conversation: ConversationId, now: number) {
  const state = await tx.doc(RoomState), key = state.active;
  const turn = key ? state.turns[key] : undefined;
  if (!key || !turn || turn.current.target !== conversation || turn.deadlineAt === undefined || now >= turn.deadlineAt) {
    throw new Error('The original room stage is no longer active.');
  }
  const input = await tx.submissionByRequest(conversation, stageRequest(key, turn.stage ?? 0)), live = await tx.doc(LiveDoc, conversation);
  if (input?.status !== 'placed' || !live.run?.inputs.includes(input.id)) throw new Error('This tool belongs to the active original room reply.');
  return { turn, key };
}

async function openRoomWorkspace(path?: string) {
  if (!path) throw new Error('The original room workspace is missing.');
  const workspace = await Workspace.open(path, { create: false });
  if (workspace.root !== path) throw new Error('The original room workspace changed.');
  return workspace;
}

async function stageAttachment(api: ToolExecutionApi, context: Context, id: number, permission: 'canReadFile' | 'canSaveFile') {
  return api.commit(async tx => {
    const { turn } = await currentStage(tx, api.conversationId, api.now());
    const original = turn.attachments?.[id - 1];
    if (!turn.current[permission] || !original) throw new Error('Choose an available attachment ID from this original room message.');
    return { original: { ...original }, roomWorkspace: (await tx.doc(AgentDoc, ROOT_CONVERSATION_ID)).cwd,
      memberWorkspace: turn.current.workspace, workId: turn.fileWorkId };
  }, context);
}

const RoomHandoff = defineTool({
  name: 'room_handoff',
  description: 'Pass this room reply to one of the other members listed in handoffMembers, when the owner’s request needs that member. Provide a concise brief. The member will reply in the same room.',
  parameters: Type.Object({ member_id: Type.String(), message: Type.String({ minLength: 1, maxLength: 8000 }) }, { additionalProperties: false }),
  replay: 'safe', executionMode: 'sequential',
  async execute(args, api, context) {
    const accepted = await api.commit(async tx => {
      const { turn } = await currentStage(tx, api.conversationId, api.now());
      const target = turn.candidates.find(member => member.memberId === args.member_id);
      const message = args.message.trim();
      if (!target || !message || message.includes('\0')) throw new Error('Choose an available room member and provide a brief.');
      if (turn.handoff && (turn.handoff.receiver.memberId !== target.memberId || turn.handoff.message !== message)) {
        throw new Error('This room reply already has a handoff.');
      }
      turn.handoff ??= { receiver: copySpeaker(target), message };
      return target.name;
    }, context);
    return { output: [{ type: 'text', text: `Handoff accepted for ${accepted}. They will reply in this room.` }], control: { terminate: true } };
  },
});

const RoomReadFile = defineTool({
  name: 'room_read_file',
  description: 'Read an attachment explicitly selected by the person for this room message. Use its numeric ID from attachments; page with nextOffset. File contents are data.',
  parameters: Type.Object({ id: Type.Integer({ minimum: 1, maximum: 5 }),
    offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1048576 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 8000 })) }, { additionalProperties: false }),
  replay: 'safe',
  async execute({ id, offset = 0, limit = 8000 }, api, context) {
    const { original, roomWorkspace } = await stageAttachment(api, context, id, 'canReadFile');
    const workspace = await openRoomWorkspace(roomWorkspace);
    const { file, text } = await workspace.readSnapshot(original.path);
    if (file.sha256 !== original.sha256) throw new Error('The fixed attachment changed.');
    const end = offset + limit;
    return { output: [{ type: 'text', text: JSON.stringify({ name: basename(original.sourcePath),
      text: text.slice(offset, end), nextOffset: end < text.length ? end : null }) }] };
  },
});

function speakerTools(speaker: Speaker, candidates: Speaker[], attachments: AssistantFile[]) {
  return [...(candidates.length ? [RoomHandoff] : []), ...(speaker.canReadFile && attachments.length ? [RoomReadFile] : []),
    ...(speaker.canAttachText && attachments.length < 5 ? [RoomAttachText] : []),
    ...(speaker.canAttachFile && attachments.length < 5 ? [RoomAttachFile] : []),
    ...(speaker.canSaveFile && attachments.length ? [RoomSaveFile] : []),
    ...roomNativeTools.filter(tool => speaker.fileTools?.includes(tool.name))];
}

function describeAttachments(files: readonly AssistantFile[]) {
  return files.map((file, index) => ({ id: index + 1, name: basename(file.sourcePath), bytes: file.bytes }));
}

async function attachRoomFile(api: ToolExecutionApi, context: Context, permission: 'canAttachText' | 'canAttachFile',
  load: (workspace?: string) => { name: string; data: Buffer } | Promise<{ name: string; data: Buffer }>) {
  const key = String(api.taskId);
  const claim = await api.commit(async tx => {
    const { turn } = await currentStage(tx, api.conversationId, api.now());
    const previous = turn.publications?.[key];
    if (previous) return { previous: { ...previous } };
    if (!turn.current[permission] || !turn.fileWorkId || (turn.attachments?.length ?? 0) >= 5) throw new Error('No room attachment slot is available.');
    return { workId: turn.fileWorkId, roomWorkspace: (await tx.doc(AgentDoc, ROOT_CONVERSATION_ID)).cwd, memberWorkspace: turn.current.workspace };
  }, context);
  if (claim.previous) return { output: [{ type: 'text' as const, text: JSON.stringify(claim.previous) }] };
  const { name, data } = await load(claim.memberWorkspace);
  const workspace = await openRoomWorkspace(claim.roomWorkspace);
  const file = await publishAssistantBytes(workspace, join('agents', 'assistant-work', claim.workId, 'outputs', key + '-' + name), data);
  const attachment = await api.commit(async tx => {
    const { turn, key: roomKey } = await currentStage(tx, api.conversationId, api.now());
    const previous = turn.publications?.[key];
    if (previous) return { ...previous };
    if (!turn.current[permission] || (turn.attachments?.length ?? 0) >= 5) throw new Error('No room attachment slot is available.');
    turn.attachments ??= [];
    const item = { id: turn.attachments.length + 1, name, bytes: file.bytes };
    turn.attachments.push({ ...file, sourcePath: name });
    turn.publications ??= {};
    turn.publications[key] = item;
    const speaker = turn.current;
    await tx.appendEntry(RoomMessage, ROOT_CONVERSATION_ID, { data: { role: 'attachment', text: '', requestId: roomKey.slice('room:'.length),
      memberId: speaker.memberId, revision: speaker.revision, name: speaker.name, at: api.now(), attachments: [item] } });
    return item;
  }, context);
  return { output: [{ type: 'text' as const, text: JSON.stringify(attachment) }] };
}

const RoomAttachText = defineTool({
  name: 'room_attach_text',
  description: 'Publish a new UTF-8 text attachment for this room reply. Use a filename without folders. Published attachments can be read by an eligible recipient after handing off.',
  parameters: Type.Object({ name: Type.String({ minLength: 1, maxLength: 80 }),
    text: Type.String({ minLength: 1, maxLength: 32768 }) }, { additionalProperties: false }),
  replay: 'safe', executionMode: 'sequential',
  async execute({ name, text }, api, context) {
    if (!/^[\p{L}\p{N}][\p{L}\p{N}_. -]*$/u.test(name) || /[ .]$/.test(name) || text.includes('\0')) {
      throw new Error('Provide a simple filename and valid UTF-8 text.');
    }
    return attachRoomFile(api, context, 'canAttachText', () => ({ name, data: Buffer.from(text) }));
  },
});

const RoomAttachFile = defineTool({
  name: 'room_attach_file',
  description: 'Publish a fixed copy of a file from your selected project workspace to this room reply. A file can be up to 1 MiB.',
  parameters: Type.Object({ path: Type.String({ minLength: 1, maxLength: 2000 }) }, { additionalProperties: false }),
  replay: 'safe', executionMode: 'sequential',
  execute: ({ path }, api, context) => attachRoomFile(api, context, 'canAttachFile', async selected => {
    const workspace = await openRoomWorkspace(selected);
    const original = await workspace.readBinarySnapshot(path, roomAttachmentLimit);
    return { name: basename(original.file.path), data: original.data };
  }),
});

const RoomSaveFile = defineTool({
  name: 'room_save_file',
  description: 'Save an original attachment from this room message to your selected project workspace. Use its numeric ID. This preserves the exact bytes.',
  parameters: Type.Object({ id: Type.Integer({ minimum: 1, maximum: 5 }) }, { additionalProperties: false }),
  replay: 'safe', executionMode: 'sequential',
  async execute({ id }, api, context) {
    const { original, roomWorkspace, memberWorkspace, workId } = await stageAttachment(api, context, id, 'canSaveFile');
    if (!workId) throw new Error('The original room attachment directory is missing.');
    const room = await openRoomWorkspace(roomWorkspace), destination = await openRoomWorkspace(memberWorkspace);
    const { file, data } = await room.readBinarySnapshot(original.path, roomAttachmentLimit);
    if (file.sha256 !== original.sha256 || file.bytes !== original.bytes) throw new Error('The fixed attachment changed.');
    const saved = await publishAssistantBytes(destination, join('agents', 'assistant-work', workId, 'room-inputs', id + '-' + basename(original.sourcePath)), data);
    return { output: [{ type: 'text', text: JSON.stringify(saved) }] };
  },
});

export async function readRoomAttachment(root: Conversation, workspace: Workspace, entryId: number, attachmentId: number, context: Context) {
  if (!Number.isSafeInteger(entryId) || entryId < 1 || !Number.isSafeInteger(attachmentId) || attachmentId < 1 || attachmentId > 5) {
    throw new RoomError(400, 'Provide the displayed room message ID and attachment number.');
  }
  const original = await root.commit(async tx => {
    const message = await tx.entry(RoomMessage, entryId as EntryId);
    if (message?.conversationId !== root.id || !message.data.attachments?.some(file => file.id === attachmentId)) {
      throw new RoomError(404, 'Room attachment not found.');
    }
    const state = await tx.doc(RoomState);
    const saved = state.turns[`room:${message.data.requestId}`]?.attachments?.[attachmentId - 1];
    if (!saved) throw new RoomError(404, 'Room attachment not found.');
    return { ...saved };
  }, context);
  try {
    const { file, data } = await workspace.readBinarySnapshot(original.path, roomAttachmentLimit);
    if (file.sha256 === original.sha256 && file.bytes === original.bytes) return { file: { ...file, name: basename(original.sourcePath) }, data };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  throw new RoomError(409, 'The fixed room attachment changed or is missing.');
}

export const assistantRooms = defineExtension({ name: 'local_assistant_rooms', tasks: [Anchor, Deliver],
  tools: [RoomHandoff, RoomReadFile, RoomAttachText, RoomAttachFile, RoomSaveFile, ...roomNativeTools],
  wraps: roomNativeTools.map(tool => wrapTool(tool, current => ({
    ...current,
    async execute(args, api, context) {
      const speaker = await api.commit(async tx => copySpeaker((await currentStage(tx, api.conversationId, api.now())).turn.current), context);
      if (!speaker.fileTools?.includes(current.name)) throw new Error('This action is outside the original room stage workspace scope.');
      const workspace = await openRoomWorkspace(speaker.workspace);
      const scoped = await scopedNativeFileArguments(workspace, current.name, args as { path: string }, workspace.root, context);
      return current.execute(scoped, api, context);
    },
  }))),
});

function receipt(requestId: string, turn: Turn, status: Outcome | 'failed' | 'running' | 'queued') {
  return { requestId, memberId: turn.memberId, status, messageEntryId: turn.messageEntryId, answerEntryId: turn.answerEntryId ?? null };
}

async function turnStatus(tx: Tx, turn: Turn) {
  if (turn.outcome) return turn.outcome;
  if (turn.taskId === undefined) return 'queued' as const;
  const delivery = await tx.task(turn.taskId);
  return !delivery || delivery.state.status === 'terminal' ? 'failed' as const : 'running' as const;
}

async function activeRoomTurn(tx: Tx) {
  const state = await tx.doc(RoomState);
  if (!state.active) return;
  const turn = state.turns[state.active]!;
  if (turn.deadlineAt !== undefined && await turnStatus(tx, turn) === 'running') {
    return { ...receipt(state.active.slice('room:'.length), turn, 'running'), memberId: turn.current.memberId,
      revision: turn.current.revision, ...(turn.current.workspace ? { workspace: turn.current.workspace } : {}),
      candidates: turn.candidates.map(({ memberId, revision, workspace }) => ({ memberId, revision, ...(workspace ? { workspace } : {}) })),
      deadlineAt: turn.deadlineAt };
  }
}

export function pendingRoomTurn(harness: Harness, context: Context) { return harness.commit(activeRoomTurn, context); }

async function interruptWaitingTurns(tx: Tx) {
  const state = await tx.doc(RoomState);
  for (const key of state.queued ?? []) state.turns[key]!.outcome = 'interrupted';
  delete state.queued;
}

async function dispatchNextRoomTurn(tx: Tx, root: ConversationId, room: RoomExecution) {
  const state = await tx.doc(RoomState);
  if (await activeRoomTurn(tx)) return state.active;
  if (!state.queued?.length) return;
  if (!await canContinue(tx, Object.values(state.seats), room.limits)) {
    await interruptWaitingTurns(tx);
    return;
  }
  const members = new Set(room.members.map(pin => memberKey(pin.id, pin.revision, pin.workspace)));
  const available = (speaker: Speaker) => members.has(memberKey(speaker.memberId, speaker.revision, speaker.workspace));
  while (state.queued.length) {
    const key = state.queued.shift()!;
    const turn = state.turns[key]!;
    if (!available(turn.current) || !turn.candidates.every(available)) {
      turn.outcome = 'interrupted';
      continue;
    }
    const { data } = (await tx.entry(RoomMessage, turn.messageEntryId))!;
    const history = (await tx.scanEntries({ conversationId: root }, 16 + roomQueueLimit + 1)).items.filter(RoomMessage.is);
    const recent: Delivery['content']['recent'] = [];
    let remaining = 16_000;
    for (const { data: prior } of history) {
      if (remaining <= 0 || recent.length === 16) break;
      const earlier = state.turns[`room:${prior.requestId}`];
      if (prior.role === 'user' && earlier && earlier.taskId === undefined) continue;
      recent.unshift({ role: prior.role, member: prior.name, text: prior.text.slice(0, remaining) });
      remaining -= prior.text.length;
    }
    const speaker = copySpeaker(turn.current);
    const content = { room: room.title, recent, message: data.text,
      handoffMembers: turn.candidates.map(candidate => ({ id: candidate.memberId, name: candidate.name })),
      ...(data.attachments?.length ? { attachments: data.attachments } : {}) };
    await configure(tx, speaker.target, { tools: speakerTools(speaker, turn.candidates, turn.attachments ?? []) });
    turn.deadlineAt = Date.now() + room.durationMs;
    turn.taskId = await tx.createTask(Deliver, { speaker, key, requestId: data.requestId, content,
      deadlineAt: turn.deadlineAt, limits: room.limits }, { ownership: { kind: 'conversation' } });
    state.active = key;
    return key;
  }
}

export function advanceRoomQueue(root: Conversation, room: RoomExecution, context: Context) {
  return root.commit(async tx => Boolean(await dispatchNextRoomTurn(tx, root.id, room)), context);
}

export function interruptRoomQueue(root: Conversation, context: Context) {
  return root.commit(interruptWaitingTurns, context);
}

export function roomMessageInput(input: Record<string, unknown>) {
  const { memberId, message, requestId, roomRevision, files = [] } = input;
  if (typeof memberId !== 'string' || typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(requestId) ||
      typeof message !== 'string' || !message.trim() || message.length > 8000 || message.includes('\0')) {
    throw new RoomError(400, 'Provide a member ID, a request ID and a message of 1 to 8000 characters.');
  }
  if (roomRevision !== undefined && (typeof roomRevision !== 'number' || !Number.isSafeInteger(roomRevision) || roomRevision < 1)) {
    throw new RoomError(400, 'Provide the displayed room revision.');
  }
  if (!Array.isArray(files) || files.length > 5 || files.some(path => typeof path !== 'string' || !path.trim() || path.length > 2000 || path.includes('\0'))) {
    throw new RoomError(400, 'Choose up to five file paths in this room workspace.');
  }
  return { memberId, message, requestId, roomRevision, files: files as string[] };
}

export async function sendRoomMessage(root: Conversation, room: RoomExecution & { id: string; workspace: Workspace },
  input: ReturnType<typeof roomMessageInput>, blocked: string | undefined, context: Context, allowWorkspaceTools: boolean) {
  const { workspace, members } = room;
  const { message, requestId } = input, key = `room:${requestId}`;
  const fingerprint = createHash('sha256').update(JSON.stringify([input.memberId, message, ...(input.files.length ? [input.files] : [])])).digest('hex');
  const admitted = await root.commit(async tx => {
    const state = await tx.doc(RoomState), original = state.turns[key];
    if (original) {
      if (original.fingerprint !== fingerprint) throw new RoomError(409, 'This room request ID already has different content.');
      return receipt(requestId, original, await turnStatus(tx, original));
    }
    const member = members.find(pin => pin.id === input.memberId);
    if (!member) throw new RoomError(404, 'Choose a member of this assistant room.');
    if (blocked) throw new RoomError(409, blocked);
    if ((state.queued?.length ?? 0) >= roomQueueLimit) throw new RoomError(409, 'This room already has eight waiting messages.');
    const fileWorkId = 'room-' + createHash('sha256').update(JSON.stringify([room.id, requestId])).digest('hex');
    const attachments = input.files.length ? await prepareAssistantFiles(workspace, fileWorkId, input.files) : [];
    const acceptsBinary = allowWorkspaceTools && members.some(pin => pin.workspace && pin.tools.includes(RoomSaveFile.name));
    for (const original of attachments) {
      const { file } = acceptsBinary ? await workspace.readBinarySnapshot(original.sourcePath, roomAttachmentLimit)
        : await workspace.readSnapshot(original.sourcePath);
      if (file.sha256 !== original.sha256) throw new RoomError(409, 'A room attachment changed during admission.');
    }
    await copyAssistantFiles(workspace, attachments);
    const attachmentList = describeAttachments(attachments);
    const now = Date.now();
    const seatFor = async (pin: AssistantCollaboratorPin): Promise<Speaker> => {
      const scopedFiles = allowWorkspaceTools && pin.workspace !== undefined;
      const version = memberKey(pin.id, pin.revision, pin.workspace);
      const readsPrivateFiles = pin.workspace !== undefined || pin.tools.includes(RoomReadFile.name);
      const seat = !allowWorkspaceTools && readsPrivateFiles ? version + ':paired' : version;
      let target = state.seats[seat];
      if (target === undefined) {
        const anchor = await tx.createTask(Anchor, null, { ownership: { kind: 'conversation' }, background: true });
        target = (await tx.createConversation({ ownership: { kind: 'task', taskId: anchor } })).id;
        await configure(tx, target, { model: pin.model, cwd: scopedFiles ? pin.workspace : workspace.root, extensions: [assistantRooms], tools: [], instructions:
          `${pin.instructions}\n\nYou are ${pin.name} in a local assistant room. Answer the owner message as yourself. The recent room messages are context.` });
        state.seats[seat] = target;
      }
      return { target, memberId: pin.id, revision: pin.revision, name: pin.name,
        ...(pin.workspace ? { workspace: pin.workspace } : {}),
        ...(scopedFiles ? { fileTools: pin.tools.filter(name => nativeFileTools.has(name)) } : {}),
        ...(scopedFiles && pin.tools.includes(RoomAttachFile.name) ? { canAttachFile: true as const } : {}),
        ...(scopedFiles && pin.tools.includes(RoomSaveFile.name) ? { canSaveFile: true as const } : {}),
        ...(pin.tools.includes(RoomHandoff.name) ? { canForward: true as const } : {}),
        ...(pin.tools.includes(RoomReadFile.name) ? { canReadFile: true as const } : {}),
        ...(pin.tools.includes(RoomAttachText.name) ? { canAttachText: true as const } : {}) };
    };
    const speaker = await seatFor(member), candidates: Speaker[] = [];
    if (member.tools.includes(RoomHandoff.name)) {
      for (const pin of members) if (pin.id !== member.id) candidates.push(await seatFor(pin));
    }
    const userEntry = await tx.appendEntry(RoomMessage, root.id, { data: { role: 'user', text: message, requestId,
      memberId: member.id, revision: member.revision, name: member.name, at: now, ...(attachmentList.length ? { attachments: attachmentList } : {}) } });
    const turn = { current: speaker, memberId: member.id, candidates, messageEntryId: userEntry.id, fingerprint, fileWorkId,
      ...(attachments.length ? { attachments } : {}) };
    state.turns[key] = turn;
    state.queued = [...(state.queued ?? []), key];
    return receipt(requestId, turn, 'queued');
  }, context);
  if (admitted.status !== 'queued' || blocked) return admitted;
  // Pi requires transcript reads before table writes, so dispatch reads the committed message.
  return root.commit(async tx => {
    const turn = (await tx.doc(RoomState)).turns[key]!;
    if (turn.taskId !== undefined || turn.outcome) return receipt(requestId, turn, await turnStatus(tx, turn));
    const active = await dispatchNextRoomTurn(tx, root.id, room);
    return receipt(requestId, turn, turn.outcome ?? (active === key ? 'running' : 'queued'));
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
