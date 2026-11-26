import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { defineDoc, LiveDoc, type ConversationId, type ConversationRecord, type EntryId, type SubmissionId, type TaskId, type Tx } from '@earendil-works/pi-durable';
import type { AssistantPin, AssistantRef } from './assistants.js';
import type { FileSnapshot } from './workspace.js';

export type AssistantPeerEpoch = { revision: number; epoch: number };
type PeerPin = Omit<AssistantPin, 'model'> & { model: { provider: string; modelId: string } };
export type AssistantSeat = {
  root: ConversationId; source: ConversationId; conversationId: ConversationId; anchor: TaskId; key: string; kind: 'standing' | 'new';
  pin: PeerPin; tools: string[]; createdAt: number;
};
export type AssistantWorkResult = { status: 'done'; submission: SubmissionId; answer: EntryId } | { status: 'unanswered'; submission: SubmissionId; reason: string };
export type AssistantWork = {
  id: string; fingerprint: string; root: ConversationId; source: ConversationId; target: ConversationId; taskId: TaskId;
  origin: AssistantPeerEpoch; parentId?: string; reworkOf?: string; lineage: string[]; depth: number; assistant: AssistantRef; brief: string; files: FileSnapshot[];
  inputRequests: string[]; messageRequestId: string; reportRequestId: string; createdAt: number;
  result?: AssistantWorkResult; stop?: { requestId: string; at: number; confirmed: boolean; ancestor?: string };
};
export type AssistantPeerState = { seats: Record<string, AssistantSeat>; work: Record<string, AssistantWork>; stopped: Record<string, true> };
export const AssistantPeers = defineDoc<AssistantPeerState>({ kind: 'local.assistant_peers', version: 1, scope: 'session',
  initial: () => ({ seats: {}, work: {}, stopped: {} }), checkpointWhen: () => true });
export type AssistantAdmission = {
  root: ConversationId; source: ConversationId; project: string; parentId?: string; sourceRole?: AssistantRef; tools: string[];
  enabled: boolean; requiresConfirmation: boolean; now: number; deadlineAt: number; maxPeers: number; maxWorks: number; maxDepth: number;
  goal: AssistantPeerEpoch & { initialized: boolean; phase: string; confirmation?: unknown };
};
export type AssistantWorkIntent = {
  requestId: string; assistant: AssistantPin; instructions: string; tools: string[]; files: FileSnapshot[];
  mode: 'standing' | 'new' | ConversationId; reworkOf?: string;
};
type NativeWork = { conversation: ConversationRecord; anchor: TaskId; taskId: TaskId };
export class AssistantPeerError extends Error { constructor(readonly status: 400 | 404 | 409, message: string) { super(message); } }
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sameEpoch = (a: AssistantPeerEpoch, b: AssistantPeerEpoch) => a.revision === b.revision && a.epoch === b.epoch;
const stopKey = (root: ConversationId, assistant: string) => digest([root, assistant]);
const ownWork = (state: AssistantPeerState, id: string) => Object.hasOwn(state.work, id) ? state.work[id] : undefined;

function validate(intent: AssistantWorkIntent) {
  const modeValid = intent.mode === 'standing' || intent.mode === 'new' || typeof intent.mode === 'number' && Number.isSafeInteger(intent.mode) && intent.mode > 0;
  if (typeof intent.requestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,119}$/.test(intent.requestId) ||
    typeof intent.instructions !== 'string' || !intent.instructions.trim() || intent.instructions.length > 32_000 || intent.instructions.includes('\0') ||
    !modeValid || intent.reworkOf !== undefined && (typeof intent.reworkOf !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,119}$/.test(intent.reworkOf)) ||
    !Array.isArray(intent.tools) || new Set(intent.tools).size !== intent.tools.length || intent.tools.some(tool => typeof tool !== 'string' || !intent.assistant.tools.includes(tool)) ||
    !Array.isArray(intent.files) || intent.files.length > 5 || intent.files.some(file => !isAbsolute(file.path) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > 5 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(file.sha256))) {
    throw new AssistantPeerError(400, 'Provide an original assistant request, explicit tool intersection and up to five bounded file snapshots.');
  }
}

// Read the current Goal in this same Tx before create() performs native table writes.
export async function claimAssistantWork(tx: Tx, authority: AssistantAdmission, intent: AssistantWorkIntent,
  create: (seat: AssistantSeat | undefined) => Promise<NativeWork>): Promise<AssistantWork> {
  validate(intent);
  const tools = [...intent.tools].sort(), origin = { revision: authority.goal.revision, epoch: authority.goal.epoch };
  const fingerprint = digest([authority.root, authority.source, authority.project, origin, authority.parentId, intent.assistant, tools, intent.instructions, intent.mode, intent.files,
    ...(intent.reworkOf ? ['rework', intent.reworkOf] : [])]);
  const state = await tx.doc(AssistantPeers), old = ownWork(state, intent.requestId);
  if (old) {
    if (old.fingerprint !== fingerprint) throw new AssistantPeerError(409, 'This assistant request already has different content.');
    return copy(old);
  }
  if (!authority.enabled || !authority.goal.initialized || authority.goal.phase !== 'working' || authority.requiresConfirmation && !authority.goal.confirmation ||
    authority.now >= authority.deadlineAt || authority.maxPeers < 1) throw new AssistantPeerError(409, 'Assistant work requires the original active execution goal and budget.');
  if (intent.assistant.project !== authority.project) throw new AssistantPeerError(404, 'Assistant not found in the original project.');
  if (intent.reworkOf) {
    const original = ownWork(state, intent.reworkOf), seat = original && state.seats[String(original.target)];
    if (!original || original.root !== authority.root || original.source !== authority.source || !seat) throw new AssistantPeerError(404, 'Original assistant work not found in this source.');
    if (!original.result || original.stop || intent.mode !== original.target || digest(intent.assistant) !== digest(seat.pin) || digest(tools) !== digest(seat.tools)) {
      throw new AssistantPeerError(409, 'Rework requires a settled original work and its exact conversation, role and tool scope.');
    }
  }
  if (tools.some(tool => !authority.tools.includes(tool))) throw new AssistantPeerError(400, 'The assistant tool ceiling exceeds its source scope.');
  const root = await tx.conversation(authority.root), source = await tx.conversation(authority.source);
  if (!root || !source) throw new AssistantPeerError(404, 'Assistant source conversation not found.');
  if (root.owner) throw new AssistantPeerError(409, 'Assistant work must retain its original ownerless task root.');
  const parent = authority.parentId ? ownWork(state, authority.parentId) : undefined;
  if (authority.source !== authority.root && (!parent || parent.root !== authority.root || parent.target !== authority.source ||
    !sameEpoch(parent.origin, origin) || parent.stop || parent.result)) throw new AssistantPeerError(409, 'The original source assistant work is no longer active.');
  if (authority.source !== authority.root) {
    const sourceSeat = state.seats[String(authority.source)];
    if (!sourceSeat || sourceSeat.root !== authority.root) throw new AssistantPeerError(409, 'The original source assistant conversation is missing.');
    if (tools.some(tool => !sourceSeat.tools.includes(tool))) throw new AssistantPeerError(400, 'The target exceeds its fixed source assistant scope.');
  }
  if (authority.source === authority.root && authority.parentId) throw new AssistantPeerError(409, 'The root conversation cannot claim another assistant’s source work.');
  const ancestors = parent?.lineage ?? (authority.sourceRole ? [authority.sourceRole.id] : []);
  if (ancestors.includes(intent.assistant.id)) throw new AssistantPeerError(409, 'Assistant work cannot return to itself or an ancestor.');
  const depth = (parent?.depth ?? 0) + 1;
  if (depth > authority.maxDepth) throw new AssistantPeerError(409, 'Assistant handoff depth limit reached.');
  if (state.stopped[stopKey(authority.root, intent.assistant.id)]) throw new AssistantPeerError(409, 'The user stopped this assistant in the original source task.');
  const all = Object.values(state.work).filter(work => work.root === authority.root);
  if (all.length >= authority.maxWorks) throw new AssistantPeerError(409, 'The original Goal assistant work limit has been reached.');
  const key = digest([authority.root, authority.source, intent.assistant, tools]);
  const seat = typeof intent.mode === 'number' ? state.seats[String(intent.mode)] : intent.mode === 'standing' ? Object.values(state.seats).find(item => item.key === key && item.kind === 'standing') : undefined;
  if (typeof intent.mode === 'number' && (!seat || seat.key !== key)) throw new AssistantPeerError(409, 'Select a compatible original assistant conversation.');
  const active = all.filter(work => !work.result && !work.stop?.confirmed);
  if ((!seat || !active.some(work => work.target === seat.conversationId)) && new Set(active.map(work => work.target)).size >= authority.maxPeers) {
    throw new AssistantPeerError(409, 'The original task already has its maximum active assistants.');
  }
  if (seat) {
    const reachable = (from: ConversationId, visited = new Set<ConversationId>()): boolean => {
      if (from === authority.source) return true;
      if (visited.has(from)) return false; visited.add(from);
      return active.some(work => work.source === from && reachable(work.target, visited));
    };
    if (reachable(seat.conversationId)) throw new AssistantPeerError(409, 'The assistant handoff would create a waiting cycle.');
  }
  const native = await create(seat ? copy(seat) : undefined);
  const target = native.conversation;
  if (seat && (target.id !== seat.conversationId || native.anchor !== seat.anchor)) throw new AssistantPeerError(409, 'Native work changed its original assistant conversation.');
  if (!seat && Object.hasOwn(state.seats, String(target.id))) throw new AssistantPeerError(409, 'A new assistant seat cannot overwrite an existing conversation.');
  if (target.owner?.taskId !== native.anchor) throw new AssistantPeerError(409, 'Native assistant ownership was not committed with its work.');
  if (!seat) state.seats[String(target.id)] = { root: authority.root, source: authority.source, conversationId: target.id,
    anchor: native.anchor, key, kind: intent.mode === 'new' ? 'new' : 'standing', pin: copy(intent.assistant), tools, createdAt: authority.now };
  const id = intent.requestId, messageRequestId = 'assistant-work:' + id, reportRequestId = 'assistant-report:' + id;
  const work: AssistantWork = { id, fingerprint, root: authority.root, source: authority.source, target: target.id, taskId: native.taskId,
    origin, ...(parent ? { parentId: parent.id } : {}), ...(intent.reworkOf ? { reworkOf: intent.reworkOf } : {}), lineage: [...ancestors, intent.assistant.id], depth, assistant: { id: intent.assistant.id, revision: intent.assistant.revision },
    brief: intent.instructions, files: copy(intent.files), inputRequests: [messageRequestId], messageRequestId, reportRequestId, createdAt: authority.now };
  state.work[id] = work;
  if (parent && !parent.inputRequests.includes(reportRequestId)) parent.inputRequests.push(reportRequestId);
  return copy(work);
}

export async function captureAssistantResult(tx: Tx, id: string): Promise<AssistantWorkResult | undefined> {
  const state = await tx.doc(AssistantPeers), work = ownWork(state, id);
  if (!work) throw new AssistantPeerError(404, 'Assistant work not found.');
  if (work.result) return copy(work.result);
  const inputs = await Promise.all(work.inputRequests.map(request => tx.submissionByRequest(work.target, request)));
  if (inputs.some(input => !input || input.status === 'queued' || input.status === 'placed')) return;
  const latest = inputs.filter(input => input !== undefined).sort((a, b) => Number(a.entry ?? a.id) - Number(b.entry ?? b.id)).at(-1)!;
  if (latest.type !== 'input') throw new AssistantPeerError(409, 'Assistant work has an unexpected native submission type.');
  if (latest.status === 'done') work.result = { status: 'done', submission: latest.id, answer: latest.answer };
  else if (latest.status === 'unanswered') work.result = { status: 'unanswered', submission: latest.id, reason: latest.reason };
  return work.result ? copy(work.result) : undefined;
}

export async function outstandingAssistantWork(tx: Tx, root: ConversationId, goal: AssistantPeerEpoch): Promise<boolean> {
  const state = await tx.doc(AssistantPeers);
  for (const work of Object.values(state.work)) {
    if (work.root !== root || !sameEpoch(work.origin, goal) || work.stop?.confirmed) continue;
    if (!work.result) return true;
    const report = await tx.submissionByRequest(work.source, work.reportRequestId);
    if (!report || report.type !== 'input' || report.status === 'unanswered' || report.status === 'queued') return true;
    // The current report turn may submit the Goal before Pi marks that same input done.
    if (report.status !== 'done' && !(await tx.doc(LiveDoc, work.source)).run?.inputs.includes(report.id)) return true;
  }
  return false;
}

function controlVersion(work: AssistantWork): string { return digest([work.id, work.taskId, work.target, work.origin, work.result, work.stop]); }
export function assistantWorkView(state: AssistantPeerState | undefined, id: string) {
  const work = state && ownWork(state, id); if (!work) return;
  const seat = state!.seats[String(work.target)];
  if (!seat) throw new AssistantPeerError(409, 'The original assistant conversation record is missing.');
  return { id: work.id, source: work.source, conversationId: work.target, conversationKind: seat.kind, nativeTaskId: work.taskId, origin: copy(work.origin), parentId: work.parentId ?? null, reworkOf: work.reworkOf ?? null, depth: work.depth,
    assistant: { ...work.assistant, name: seat.pin.name }, brief: work.brief.slice(0, 1000), truncated: work.brief.length > 1000,
    files: copy(work.files), result: work.result ? copy(work.result) : null, stop: work.stop ? copy(work.stop) : null, controlVersion: controlVersion(work) };
}

export async function requestAssistantStop(tx: Tx, root: ConversationId, id: string, version: string, requestId: string, at: number): Promise<AssistantWork> {
  const state = await tx.doc(AssistantPeers), work = ownWork(state, id);
  if (!work || work.root !== root) throw new AssistantPeerError(404, 'Assistant work not found.');
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(requestId)) throw new AssistantPeerError(400, 'Provide an original stop request ID.');
  if (work.stop?.requestId === requestId) return copy(work);
  await captureAssistantResult(tx, id);
  if (work.stop || work.result || controlVersion(work) !== version) throw new AssistantPeerError(409, 'The displayed assistant work changed; read its current state before stopping.');
  const subtree = [work];
  for (const current of subtree) {
    subtree.push(...Object.values(state.work).filter(child => child.parentId === current.id));
    if (!current.stop) current.stop = { requestId: current.id === id ? requestId : digest(['assistant-subtree-stop', requestId, id, current.id]),
      at, confirmed: false, ...(current.id === id ? {} : { ancestor: id }) };
    state.stopped[stopKey(root, current.assistant.id)] = true;
  }
  return copy(work);
}

export async function confirmAssistantStop(tx: Tx, id: string, requestId: string): Promise<void> {
  const state = await tx.doc(AssistantPeers), work = ownWork(state, id);
  if (!work?.stop || work.stop.requestId !== requestId) throw new AssistantPeerError(409, 'This stop belongs to another assistant work version.');
  const task = await tx.task(work.taskId);
  if (!task || task.state.status !== 'terminal') throw new AssistantPeerError(409, 'The native assistant task has not stopped yet.');
  for (const request of work.inputRequests) {
    const input = await tx.submissionByRequest(work.target, request);
    if (input?.status === 'queued' || input?.status === 'placed') throw new AssistantPeerError(409, 'The original native assistant input is still active.');
  }
  if (Object.values(state.work).some(child => child.parentId === id && !child.stop?.confirmed)) throw new AssistantPeerError(409, 'Original nested assistant work has not stopped yet.');
  work.stop.confirmed = true;
}
