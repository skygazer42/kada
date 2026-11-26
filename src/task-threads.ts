import { createHash } from 'node:crypto';
import { Type } from '@earendil-works/pi-ai';
import { LiveDoc, ROOT_CONVERSATION_ID, ToolTask, defineDoc, defineExtension, defineTool, hook, type SubmissionId } from '@earendil-works/pi-durable';

export type ThreadOrigin = { sourceTaskId: string; title: string; openedBy: 'owner' | 'assistant'; reportBack?: true };
export type TaskThread = Partial<ThreadOrigin> & { revision: number; archivedAt?: number };
export type ThreadReport = { taskId: string; sourceTaskId: string; title: string; revision: number; candidateId: string; completedAt: number; summary: string; artifacts: string[] };
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

export function threadTools(open: (input: { title: string; message: string; reportBack?: boolean }, originalInput: SubmissionId) => Promise<unknown>,
  reporting: () => Promise<boolean>) {
  return defineExtension({ name: 'local_thread_tools', hooks: [hook(ToolTask, {
    async beforeTool(_call, api) {
      if (api.conversationId === ROOT_CONVERSATION_ID && await reporting()) return { block: 'This independent work report only authorizes a text reply.' };
    },
  })], tools: [defineTool({
    name: 'start_thread', description: 'Open a separate local task only when the person asks to start a different thread. Pass its title and the requested work. The new task prepares a brief and waits for the owner to confirm execution. Set report_back only when the person requests the verified result in this original chat. Report the new ID and finish this turn. One thread may be opened per person input.',
    parameters: Type.Object({ title: Type.String({ minLength: 1, maxLength: 80 }), message: Type.String({ minLength: 1, maxLength: 32_000 }),
      report_back: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
    replay: 'safe', executionMode: 'sequential',
    execute: async (args, api, context) => {
      if (api.conversationId !== ROOT_CONVERSATION_ID) throw new Error('Only the local main conversation can open a thread.');
      const originalInput = (await api.snapshot(LiveDoc, api.conversationId, context))?.run?.inputs.at(-1);
      if (!originalInput) throw new Error('The original conversation input is unavailable.');
      return { output: [{ type: 'text', text: JSON.stringify(await open({ title: args.title, message: args.message, reportBack: args.report_back }, originalInput)) }] };
    },
  })] });
}
