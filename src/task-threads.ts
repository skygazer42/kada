import { createHash } from 'node:crypto';
import { Type, type Models } from '@earendil-works/pi-ai';
import { LiveDoc, ROOT_CONVERSATION_ID, ToolTask, defineDoc, defineExtension, defineTool, hook, type SubmissionId } from '@earendil-works/pi-durable';
import type { ModelRef } from './config.js';

export type ThreadOrigin = { sourceTaskId: string; title: string; openedBy: 'owner' | 'assistant'; reportBack?: true; modelSelection?: ModelRef };
export type TaskThread = Partial<ThreadOrigin> & { revision: number; archivedAt?: number };
export type ThreadReport = { taskId: string; sourceTaskId: string; title: string; revision: number; candidateId: string; completedAt: number; summary: string; artifacts: string[]; model?: Pick<ModelRef, 'provider' | 'modelId'> };
export type ReceivedThreadReport = ThreadReport & { mode: 'resumed' | 'recorded' };
export const ThreadReports = defineDoc<{ outgoing?: ThreadReport; received: Record<string, ReceivedThreadReport> }>({
  scope: 'session', kind: 'local.thread_reports', version: 1, initial: () => ({ received: {} }), checkpointWhen: () => true,
});
export const threadReportRequestPrefix = 'thread-report:';

export function threadTitle(input: unknown): string {
  if (typeof input !== 'string' || /[\p{Cc}\u2028\u2029]/u.test(input) || !input.trim() || input.trim().length > 80) {
    throw new Error('Provide a one-line thread title of 1 to 80 characters.');
  }
  return input.trim();
}

export function threadTaskId(source: string, openedBy: ThreadOrigin['openedBy'], requestId: string) {
  const bytes = createHash('sha256').update(JSON.stringify(['kada/thread', source, openedBy, requestId])).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

export async function selectThreadModel(models: Models, ref: ModelRef): Promise<ModelRef> {
  if (!models.getModel(ref.provider, ref.modelId)) throw new Error('Unknown thread model. Use the installed Pi model catalog.');
  const selected = (await models.getAvailable(ref.provider)).find(model => model.provider === ref.provider && model.id === ref.modelId);
  if (!selected) throw new Error('The selected thread model is unavailable. Check provider sign-in and model access.');
  return { provider: selected.provider, modelId: selected.id };
}

export function threadTools(models: Models, current: ModelRef,
  open: (input: { title: string; message: string; reportBack?: boolean; modelSelection?: ModelRef }, originalInput: SubmissionId) => Promise<unknown>,
  reporting: () => Promise<boolean>) {
  return defineExtension({ name: 'local_thread_tools', hooks: [hook(ToolTask, {
    async beforeTool(_call, api) {
      if (api.conversationId === ROOT_CONVERSATION_ID && await reporting()) return { block: 'This independent work report only authorizes a text reply.' };
    },
  })], tools: [defineTool({
    name: 'list_models', description: 'List Pi models with configured provider credentials for an independent thread. Search by provider, model ID or name. Copy the provider and modelId exactly into start_thread model_selection if the person requests that model.',
    parameters: Type.Object({ search: Type.Optional(Type.String({ maxLength: 200 })), page: Type.Optional(Type.Integer({ minimum: 1 })) }, { additionalProperties: false }),
    replay: 'safe', executionMode: 'sequential',
    execute: async (args, api, context) => {
      if (api.conversationId !== ROOT_CONVERSATION_ID) throw new Error('Only the local main conversation can list thread models.');
      const search = args.search?.trim().toLowerCase() ?? '', page = args.page ?? 1, size = 20;
      const items = (await models.getAvailable(undefined, { signal: context.abortSignal }))
        .filter(model => [model.provider, model.id, model.name].some(value => value.toLowerCase().includes(search)))
        .map(model => ({ provider: model.provider, modelId: model.id, name: model.name }))
        .sort((a, b) => a.provider.localeCompare(b.provider) || a.modelId.localeCompare(b.modelId));
      return { output: [{ type: 'text', text: JSON.stringify({ current, items: items.slice((page - 1) * size, page * size), nextPage: page * size < items.length ? page + 1 : null }) }] };
    },
  }), defineTool({
    name: 'start_thread', description: 'Open a separate local task only when the person asks to start a different thread. Pass its title and the requested work. For an explicitly requested model, copy its model_selection from list_models. The new task prepares a brief and waits for the owner to confirm execution. Set report_back only when the person requests the verified result in this original chat. Report the new ID and finish this turn. One thread may be opened per person input.',
    parameters: Type.Object({ title: Type.String({ minLength: 1, maxLength: 80 }), message: Type.String({ minLength: 1, maxLength: 32_000 }),
      model_selection: Type.Optional(Type.Object({ provider: Type.String({ minLength: 1 }), modelId: Type.String({ minLength: 1 }) }, { additionalProperties: false })),
      report_back: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
    replay: 'safe', executionMode: 'sequential',
    execute: async (args, api, context) => {
      if (api.conversationId !== ROOT_CONVERSATION_ID) throw new Error('Only the local main conversation can open a thread.');
      const originalInput = (await api.snapshot(LiveDoc, api.conversationId, context))?.run?.inputs.at(-1);
      if (!originalInput) throw new Error('The original conversation input is unavailable.');
      return { output: [{ type: 'text', text: JSON.stringify(await open({ title: args.title, message: args.message,
        reportBack: args.report_back, modelSelection: args.model_selection }, originalInput)) }] };
    },
  })] });
}
