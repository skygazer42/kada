import assert from 'node:assert/strict';
import test from 'node:test';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentTools, Type } from '@earendil-works/pi-ai';
import { createRegistry, defineExtension, defineTool, Harness, MemoryStorage } from '@earendil-works/pi-durable';
import { assistantPolicy, assistantTools } from '../src/assistant-policy.js';
import type { AssistantPin } from '../src/assistants.js';

const pin = (tools: string[]): AssistantPin => ({ id: '6cb56316-39ee-4624-8a20-256d80f56621', revision: 1, project: process.cwd(),
  name: 'Reader', description: '', instructions: 'ROLE_READER_291', model: { provider: 'role-policy', modelId: 'scripted' }, tools });

test('role tools intersect the original set and keep child question controls out of the coordinator', () => {
  const tools = ['read', 'write', 'task_submit', 'delegation_ask'].map(name => defineTool({ name, description: name, parameters: Type.Object({}), execute: async () => ({ output: [] }) }));
  assert.deepEqual(assistantTools(tools, pin(['read'])).map(tool => tool.name), ['read', 'task_submit']);
  assert.deepEqual(assistantTools(tools, pin(['read']), true).map(tool => tool.name), ['read', 'task_submit', 'delegation_ask']);
});

for (const mode of ['direct', 'nested', 'load', 'verification']) test('fixed role policy blocks ' + mode + ' beyond its actual scope', async () => {
  let effects = 0; const offered: string[][] = [];
  const write = defineTool({ name: 'write', description: 'Synthetic write effect.', parameters: Type.Object({}), execute: async () => {
    effects++; return { output: [{ type: 'text' as const, text: 'Wrote.' }] };
  } });
  const read = defineTool({ name: 'read', description: 'Synthetic read.', parameters: Type.Object({}), execute: async () => ({ output: [] }) });
  const bridge = defineTool({ name: 'bridge', description: 'Nest a write.', parameters: Type.Object({}), execute: async (_args, api, context) => {
    const nested = await api.executeTool('write', {}, context);
    return { output: [{ type: 'text' as const, text: JSON.stringify(nested) }], isError: nested.isError };
  } });
  const loader = defineTool({ name: 'loader', description: 'Load names.', parameters: Type.Object({}), execute: async () => ({
    output: [{ type: 'text' as const, text: 'Names found.' }], control: { addTools: ['write', 'read'] },
  }) });
  const prepare = defineTool({ name: 'task_prepare', description: 'Save a synthetic brief.', parameters: Type.Object({ criteria: Type.Array(Type.Object({
    verification: Type.Optional(Type.Object({ command: Type.String() })),
  })) }), execute: async () => { effects++; return { output: [] }; } });
  const action = mode === 'nested' ? bridge : mode === 'load' ? loader : mode === 'verification' ? prepare : write;
  const role = pin(['read', ...(mode === 'nested' ? ['bridge'] : mode === 'load' ? ['loader'] : [])]);
  const tools = [read, write, bridge, loader, prepare], extension = defineExtension({ name: 'synthetic_actions', tools }), policy = assistantPolicy(role);
  const registry = createRegistry(); registry.install(extension); registry.install(policy);
  const provider = fauxProvider({ provider: role.model.provider, models: [{ id: role.model.modelId }] });
  provider.setResponses(Array.from({ length: 4 }, () => context => {
    offered.push(getCurrentTools(context.messages).map(tool => tool.name));
    const results = context.messages.filter(message => message.role === 'toolResult');
    if (!results.length) return fauxAssistantMessage(fauxToolCall(action.name, mode === 'verification' ? { criteria: [{ verification: { command: 'synthetic-command' } }] } : {}), { stopReason: 'toolUse' });
    if (mode === 'load' && results.length === 1) return fauxAssistantMessage(fauxToolCall(write.name, {}), { stopReason: 'toolUse' });
    return fauxAssistantMessage('Scope observed.');
  }));
  const models = createModels(); models.setProvider(provider.provider);
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, ctx);
  try {
    // Deliberately restore an excessive native set: execution hooks must still enforce the pin.
    const root = await harness.root(ctx, { agent: { model: role.model, extensions: [extension, policy], tools, modelTools: assistantTools(tools, role) } });
    const submitted = await root.submit({ type: 'input', content: 'Exercise the declared scope.' }, ctx);
    assert.equal((await submitted.wait(ctx)).status, 'done'); assert.equal(effects, 0);
    assert(offered.every(names => !names.includes('write')), 'loaded names must not leak extra offered tools');
    const messages = (await root.context(ctx)).messages;
    assert(JSON.stringify(messages).includes('ROLE_READER_291'));
    assert(messages.some(message => message.role === 'toolResult' && message.isError));
  } finally { await harness.close(ctx); }
});
