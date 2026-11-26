import { defineTask, LiveDoc, type ConversationId, type Harness, type TaskId, type Tx } from '@earendil-works/pi-durable';
import type { Context } from '@earendil-works/chord/context';
import { AssistantPeerError, AssistantPeers, captureAssistantResult, type AssistantWork, type AssistantWorkInput } from './assistant-peer-state.js';
import { GoalDoc } from './goal.js';
import type { AssistantPeerControl } from './assistant-peers.js';

export type AssistantPeerControlRunner = <T>(action: (control: AssistantPeerControl) => Promise<T>) => Promise<T>;
export type AssistantInputRequest = { id: string; requestId: string; text: string; questionId?: string };
export const assistantInputDeliveryId = (requestId: string) => 'assistant-input:' + requestId;
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export async function assistantWorkAvailability(tx: Tx, control: AssistantPeerControl, work: AssistantWork, now: number) {
  const goal = await tx.doc(GoalDoc), state = await tx.doc(AssistantPeers);
  if (!control.enabled || now >= control.deadlineAt || work.root !== control.root || work.origin.revision !== goal.revision || work.origin.epoch !== goal.epoch ||
    control.requiresConfirmation && !goal.confirmation || work.stop || work.parentId && state.work[work.parentId]?.stop) return 'inactive' as const;
  return goal.phase === 'waiting_user' ? 'waiting' as const : goal.phase === 'working' ? 'active' as const : 'inactive' as const;
}

export async function sourceAssistantWork(tx: Tx, source: ConversationId, root: ConversationId): Promise<AssistantWork | undefined> {
  if (source === root) return;
  const state = await tx.doc(AssistantPeers), live = await tx.doc(LiveDoc, source), found: AssistantWork[] = [];
  for (const work of Object.values(state.work)) {
    if (work.root !== root || work.target !== source || work.result || work.stop) continue;
    for (const request of work.inputRequests) {
      const input = await tx.submissionByRequest(source, request);
      if (input && live.run?.inputs.includes(input.id)) { found.push(work); break; }
    }
  }
  return found.length === 1 ? found[0] : undefined;
}

export async function recordAssistantInput(tx: Tx, control: AssistantPeerControl, request: AssistantInputRequest, kind: AssistantWorkInput['kind'],
  source: ConversationId | undefined, now: number, create: (work: AssistantWork) => Promise<TaskId>): Promise<AssistantWorkInput> {
  if (typeof request.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,119}$/.test(request.id) ||
    typeof request.requestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,119}$/.test(request.requestId) || typeof request.text !== 'string' || !request.text.trim() || request.text.length > 32_000 || request.text.includes('\0') ||
    kind === 'guidance' && request.questionId !== undefined ||
    kind === 'answer' && (typeof request.questionId !== 'string' || !/^[1-9]\d*$/.test(request.questionId))) throw new AssistantPeerError(400, 'Provide an original work input request and nonblank answer or guidance.');
  const state = await tx.doc(AssistantPeers), work = state.work[request.id];
  if (!work || work.root !== control.root || source !== undefined && work.source !== source) throw new AssistantPeerError(404, 'Assistant work not found in this source.');
  for (const other of Object.values(state.work)) {
    if (!other.inputs || !Object.hasOwn(other.inputs, request.requestId)) continue;
    const old = other.inputs[request.requestId]!;
    if (other.id !== work.id || old.kind !== kind || old.text !== request.text || old.questionId !== request.questionId) throw new AssistantPeerError(409, 'This original assistant input request already has different content.');
    return copy(old);
  }
  await captureAssistantResult(tx, work.id);
  if (work.result || await assistantWorkAvailability(tx, control, work, now) === 'inactive') throw new AssistantPeerError(409, 'The original assistant work is no longer active.');
  const question = kind === 'answer' ? work.questions?.[request.questionId!] : undefined;
  if (kind === 'answer' && (!question || question.answer)) throw new AssistantPeerError(409, 'The original assistant question changed or already has an answer.');
  if (Object.keys(work.inputs ?? {}).length >= 32) throw new AssistantPeerError(409, 'The original assistant work has reached its follow-up input limit.');
  const taskId = await create(copy(work)), input: AssistantWorkInput = { requestId: request.requestId, kind, text: request.text, taskId,
    ...(question ? { questionId: question.id } : {}) };
  work.inputs ??= {};
  work.inputs[request.requestId] = input;
  work.inputRequests.push(assistantInputDeliveryId(request.requestId));
  if (question) question.answer = { requestId: request.requestId, text: request.text };
  return copy(input);
}

export function assistantInputTask(withControl: AssistantPeerControlRunner) {
  return defineTask<{ id: string; requestId: string }, { phase: 'deliver' }, null>({
    name: 'local.assistant_peer_input', version: 1, initial: () => ({ phase: 'deliver' }),
    phases: { deliver: async (task, runtime, context) => {
      const deliver = await withControl(async control => {
        let message: { target: ConversationId; content: string; requestId: string } | undefined;
        let inactive = false;
        await runtime.commit(async tx => {
          const state = await tx.doc(AssistantPeers), work = state.work[task.input.id], input = work?.inputs?.[task.input.requestId];
          if (!work || !input) throw new AssistantPeerError(409, 'The original assistant follow-up is missing.');
          const status = await assistantWorkAvailability(tx, control, work, runtime.now());
          if (status === 'inactive') { inactive = true; return; }
          if (status === 'waiting') return;
          const deliveryId = assistantInputDeliveryId(input.requestId);
          const existing = await tx.submissionByRequest(work.target, deliveryId);
          const original = await tx.submissionByRequest(work.target, work.messageRequestId);
          const question = input.questionId ? work.questions?.[input.questionId] : undefined;
          if (!existing) {
            if (!original || original.status === 'queued') return;
            if (input.kind === 'guidance') {
              // A turn can still ask a question until its input settles.
              for (const requestId of work.inputRequests) {
                if (requestId === deliveryId) continue;
                const prior = await tx.submissionByRequest(work.target, requestId);
                if (prior?.status === 'placed' || prior?.status === 'queued') return;
              }
              for (const asked of Object.values(work.questions ?? {})) {
                if (!asked.answer) return;
                const answered = await tx.submissionByRequest(work.target, assistantInputDeliveryId(asked.answer.requestId));
                if (!answered || answered.status === 'queued' || answered.status === 'placed') return;
              }
              for (const earlier of Object.values(work.inputs ?? {})) {
                if (earlier.kind === 'guidance' && earlier.taskId < input.taskId &&
                    !await tx.submissionByRequest(work.target, assistantInputDeliveryId(earlier.requestId))) return;
              }
            }
            if (question) {
              const asking = await tx.submissionByRequest(work.target, question.submissionRequestId);
              if (!asking || asking.status === 'queued' || asking.status === 'placed') return;
            }
          }
          const content = (input.kind === 'answer' ? 'ASSISTANT_ANSWER ' : 'ASSISTANT_GUIDANCE ') + JSON.stringify({ id: work.id,
            ...(input.questionId ? { questionId: input.questionId } : {}), text: input.text, originalBrief: work.brief, files: work.files });
          message = { target: work.target, content, requestId: deliveryId };
        }, context);
        if (!message) return { inactive };
        const peer = await runtime.conversation(message.target, context);
        if (!peer) throw new AssistantPeerError(409, 'The original assistant follow-up conversation is missing.');
        // Pi can merge steer + followUp at a final boundary; use independent native turns for work-bound inputs.
        return { inactive, submission: await peer.submit({ type: 'input', content: message.content, requestId: message.requestId, whenBusy: 'followUp',
          entry: { kind: 'local.assistant.input', data: { workId: task.input.id } } }, context) };
      });
      if ('submission' in deliver && deliver.submission) await deliver.submission.wait(context);
      if (!('submission' in deliver) && !deliver.inactive) return runtime.sleepUntil(runtime.now() + 200, { phase: 'deliver' }, context);
      await runtime.commit(() => ({ status: 'terminal', outcome: deliver.inactive ? { status: 'aborted' } : { status: 'completed', result: null } }), context);
    } },
    abort: (_task, runtime, context) => runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context),
  });
}

async function ownerInput(harness: Harness, request: AssistantInputRequest, kind: AssistantWorkInput['kind'], withControl: AssistantPeerControlRunner, context: Context) {
  const task = assistantInputTask(withControl);
  return withControl(async control => {
    const result = await harness.commit(tx => recordAssistantInput(tx, control, request, kind, undefined, Date.now(), work =>
      tx.createTask(task, { id: work.id, requestId: request.requestId }, { conversationId: work.source, ownership: { kind: 'conversation' }, background: true })), context);
    if (control.enabled) harness.resume();
    return result;
  });
}
export const answerAssistantWork = (harness: Harness, request: AssistantInputRequest, withControl: AssistantPeerControlRunner, context: Context) => ownerInput(harness, request, 'answer', withControl, context);
export const guideAssistantWork = (harness: Harness, request: AssistantInputRequest, withControl: AssistantPeerControlRunner, context: Context) => ownerInput(harness, request, 'guidance', withControl, context);
