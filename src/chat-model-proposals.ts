import { Type } from '@earendil-works/pi-ai';
import { defineExtension, defineTool, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable';
import type { ModelRef } from './config.js';
import type { ModelProposal } from './provider-settings.js';

export function chatModelProposals(propose: (id: string, ref: ModelRef, reason: string) => Promise<ModelProposal>) {
  return defineExtension({ name: 'local_model_proposals', tools: [defineTool({
    name: 'propose_model', description: 'Propose a project default model when the user wants to change it. Use the exact provider and model ID from assistant_catalog and explain the benefit. The owner reviews the proposal; your current conversation retains its pinned model.',
    parameters: Type.Object({ provider: Type.String({ minLength: 1, maxLength: 160 }), modelId: Type.String({ minLength: 1, maxLength: 240 }),
      reason: Type.String({ minLength: 1, maxLength: 500 }) }, { additionalProperties: false }),
    replay: 'safe', executionMode: 'sequential',
    execute: async ({ provider, modelId, reason }, api) => {
      if (api.conversationId !== ROOT_CONVERSATION_ID) throw new Error('Only the local main conversation can propose a model.');
      return { output: [{ type: 'text', text: JSON.stringify(await propose(String(api.taskId), { provider, modelId }, reason)) }] };
    },
  })] });
}
