import { Type } from '@earendil-works/pi-ai';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { defineDoc, defineExtension, defineTool, LiveDoc, type ConversationId, type Harness, type SubmissionId, type Tx, type ToolExecutionApi } from '@earendil-works/pi-durable';
import { changeGoal, GoalDoc, plain, type GoalState } from './goal.js';
import type { InputImage } from './input-images.js';
import type { CredentialDestination } from './application-credentials.js';

export type UserQuestion = { id: string; text: string; options: string[]; detail?: string; createdAt: number;
  browserSignIn?: 'login' | 'verification'; credential?: CredentialDestination & { expectedRevision: number } };
type SavedQuestion = UserQuestion & { browserDriver?: string; submissionId: SubmissionId; revision?: number; epoch?: number; retired?: true; answer?: { requestId: string; text: string } };
export const Questions = defineDoc<{
  current?: string; questions: Record<string, SavedQuestion>;
  outbox?: { questionId: string; requestId: string; content: string; images?: InputImage[] };
}>({ scope: 'conversation', kind: 'local.user_questions', version: 1, history: 'latest', fork: 'initial', initial: () => ({ questions: {} }), checkpointWhen: () => true });
export class QuestionError extends Error { constructor(readonly status: number, message: string) { super(message); } }

export const ChoiceFields = {
  options: Type.Array(Type.String({ minLength: 1, maxLength: 80 }), { minItems: 2, maxItems: 4, uniqueItems: true }),
  detail: Type.Optional(Type.String({ maxLength: 4000 })),
};
export function questionChoices(text: string, options: string[], detail?: string) {
  const valid = (value: string, max: number) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !value.includes('\0');
  if (!valid(text, 240) || !Array.isArray(options) || options.length < 2 || options.length > 4 || options.some(option => !valid(option, 80)) ||
    new Set(options.map(option => option.trim())).size !== options.length || detail !== undefined && (typeof detail !== 'string' || detail.length > 4000 || detail.includes('\0'))) {
    throw new QuestionError(400, 'Provide a short question and two to four distinct, nonblank choices.');
  }
  return { text: text.trim(), options: options.map(option => option.trim()), ...(detail?.trim() ? { detail: detail.trim() } : {}) };
}

export async function currentQuestion(harness: Pick<Harness, 'snapshot'>, conversation: ConversationId, submissionId: SubmissionId | undefined, goal?: GoalState) {
  const state = await harness.snapshot(Questions, conversation, context), question = state?.current ? state.questions[state.current] : undefined;
  if (!question || question.answer || question.retired || question.submissionId !== submissionId ||
    (goal ? question.revision !== goal.revision || question.epoch !== goal.epoch || !['waiting_user', 'clarifying'].includes(goal.phase) : question.revision !== undefined)) return null;
  const { id, text, options, detail, createdAt, credential, browserSignIn } = question;
  return plain({ id, text, options, createdAt, ...(detail ? { detail } : {}), ...(credential ? { credential } : {}),
    ...(browserSignIn ? { browserSignIn } : {}) });
}

export async function recordQuestionAnswer(tx: Tx, conversation: ConversationId, questionId: string, requestId: string, text: string, goal?: GoalState, protectedInput = false) {
  const state = await tx.doc(Questions, conversation), question = state.questions[questionId];
  for (const other of Object.values(state.questions)) if (other.id !== questionId && other.answer?.requestId === requestId) throw new QuestionError(409, 'This request ID already answered another question.');
  if (!question) throw new QuestionError(409, 'This question is no longer available.');
  if (question.credential && !protectedInput) throw new QuestionError(400, 'Use the protected credential input; do not send a credential in chat.');
  if (question.browserSignIn && !protectedInput) throw new QuestionError(400, 'Use the browser sign-in controls to answer this request.');
  if (question.answer) {
    if (question.answer.requestId !== requestId || question.answer.text !== text) throw new QuestionError(409, 'This question already has a different answer.');
    return;
  }
  if (state.current !== questionId || question.retired || (goal ? question.revision !== goal.revision || question.epoch !== goal.epoch || !['waiting_user', 'clarifying'].includes(goal.phase) : question.revision !== undefined)) {
    throw new QuestionError(409, 'This question changed. Read the current question before answering.');
  }
  question.answer = { requestId, text };
}

export async function saveQuestion(api: ToolExecutionApi, data: Pick<SavedQuestion, 'text' | 'options' | 'detail' | 'credential' | 'browserSignIn' | 'browserDriver'>, preparation: boolean, remote: boolean, ctx: typeof context, toolName = 'ask_user') {
  const hasGoal = (await api.snapshot(GoalDoc, ctx))?.initialized, id = String(api.taskId);
  await api.commit(async tx => {
    const state = await tx.doc(Questions, api.conversationId);
    if (state.questions[id]) return;
    const live = await tx.doc(LiveDoc, api.conversationId), submissionId = live.run?.inputs.at(-1);
    if (live.tools?.length !== 1 || !submissionId) throw new QuestionError(409, 'Invoke the question tool on its own.');
    const previous = state.current ? state.questions[state.current] : undefined;
    if (previous && !previous.answer && !previous.retired) {
      if (previous.submissionId === submissionId) throw new QuestionError(409, 'The current question still needs an answer.');
      previous.retired = true;
    }
    state.current = id;
    state.questions[id] = { id, ...data, submissionId, createdAt: api.now() };
    if (hasGoal) await changeGoal(tx, (goal, record) => {
      if (goal.phase !== 'working') throw new QuestionError(409, 'The task is not ready to ask another question.');
      state.questions[id]!.revision = goal.revision; state.questions[id]!.epoch = goal.epoch;
      goal.phase = preparation && !goal.confirmation ? 'clarifying' : 'waiting_user'; goal.question = data.text; goal.reason = data.text;
      record(goal.phase, data.text);
    }, remote ? api.conversationId : undefined);
    else if (remote) await tx.appendEntry(api.conversationId, { kind: 'local.goal.remote_progress', data: { event: 'waiting_user', timestamp: api.now() } });
  }, ctx);
  const text = data.browserSignIn ? 'Browser handoff requested. Wait for the user to take over and respond. Passwords and codes belong in the browser.'
    : toolName === 'request_credential' ? 'Protected credential input requested. Never ask for its value in chat.' : 'Question saved; wait for the user answer.';
  return { output: [{ type: 'text' as const, text }], control: { terminate: true } };
}

export function questionExtension(preparation: boolean, remote: boolean) {
  return defineExtension({ name: 'local_user_questions', tools: [defineTool({
    name: 'ask_user', description: 'Ask one material question with two to four choices and optional context, then wait. Call this tool alone. The user may choose or reply with other text. This is a question only: never use choices as permission to execute a task, approve an external action, or collect a secret. A normal chat question does not create a Goal.',
    parameters: Type.Object({ question: Type.String({ minLength: 1, maxLength: 240 }), ...ChoiceFields }, { additionalProperties: false }),
    replay: 'safe', executionMode: 'sequential', callers: ['model'],
    execute: async (args, api, ctx) => {
      const data = questionChoices(args.question, args.options, args.detail);
      return saveQuestion(api, data, preparation, remote, ctx);
    },
  })] });
}
