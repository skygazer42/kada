import assert from 'node:assert/strict';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { defineExtension, hook, ToolTask } from '@earendil-works/pi-durable';
import { LocalRuntime } from '../../src/runtime.js';
import { hasTool, until } from '../helpers.js';

const [phase, directory, stage] = process.argv.slice(2) as [string, string, string];
const workspace = join(directory, 'workspace'), statePath = join(directory, 'fixture.json');
const state: { id: string; assistantId?: string } = phase === 'create' ? { id: 'fb369f45-4caa-4c8c-bc22-36b7d20c0e52' } : JSON.parse(await readFile(statePath, 'utf8'));
const reader = { provider: 'role-reader', modelId: 'reader' }, fallback = { provider: 'role-fallback', modelId: 'writer' };
const oldModel = fauxProvider({ provider: reader.provider, models: [{ id: reader.modelId }] });
oldModel.setResponses(Array.from({ length: 8 }, () => async context => {
  await appendFile(join(directory, 'model-calls.txt'), 'reader\n');
  assert(JSON.stringify(context.messages).includes('ROLE_PIN_ORIGINAL_719')); assert(!hasTool(context, 'write'));
  const results = context.messages.filter(message => message.role === 'toolResult');
  if (!results.some(result => result.toolName === 'read')) return fauxAssistantMessage(fauxToolCall('read', { path: 'seed.txt' }), { stopReason: 'toolUse' });
  if (!results.some(result => result.toolName === 'write')) return fauxAssistantMessage(fauxToolCall('write', { path: 'forbidden.txt', content: 'forbidden' }), { stopReason: 'toolUse' });
  assert.equal(results.find(result => result.toolName === 'write')!.isError, true);
  return fauxAssistantMessage(fauxToolCall('task_submit', { summary: 'Original role retained; forbidden write refused.', artifacts: [] }), { stopReason: 'toolUse' });
}));
const newModel = fauxProvider({ provider: fallback.provider, models: [{ id: fallback.modelId }] });
newModel.setResponses([async () => { await appendFile(join(directory, 'model-calls.txt'), 'WRONG_MODEL\n'); throw new Error('The new role must not replace an admitted task.'); }]);
const models = createModels(); models.setProvider(oldModel.provider); models.setProvider(newModel.provider);
const barrier = defineExtension({ name: 'role_read_barrier', hooks: [hook(ToolTask, { async beforeTool(call) {
  if (phase === 'create' && stage === 'read-pending' && call.name === 'read') {
    console.log(JSON.stringify({ type: 'ready', id: state.id })); await setTimeout(60_000);
  }
} })] });
const runtime = new LocalRuntime({ dataDir: directory, port: 4317, model: fallback, maxSubagents: 0, maxDurationMs: 600_000, review: false, discovery: false, web: false }, { models, extensions: [barrier] });
try {
  if (phase === 'create') {
    await mkdir(workspace); await writeFile(join(workspace, 'seed.txt'), 'ROLE_ORIGINAL_SEED');
    const role = await runtime.assistants.create({ workspace, name: 'Original reader', instructions: 'ROLE_PIN_ORIGINAL_719', model: reader, tools: ['read'] });
    state.assistantId = role.id; await writeFile(statePath, JSON.stringify(state));
    if (stage === 'meta-saved') {
      const open = runtime['open'].bind(runtime);
      runtime['open'] = async (...args) => { console.log(JSON.stringify({ type: 'ready', id: state.id })); await setTimeout(60_000); return open(...args); };
    }
    await runtime.create('Read the original evidence.', workspace, [], { id: state.id, assistant: { id: role.id, revision: 1 } });
    await setTimeout(60_000);
  } else {
    await runtime.assistants.update(state.assistantId!, { revision: 1, name: 'Changed writer', instructions: 'ROLE_PIN_REPLACEMENT_318', model: fallback, tools: ['read', 'write', 'bash'] });
    await runtime.recover();
    const done = await until(() => runtime.status(state.id), row => ['completed', 'failed', 'blocked', 'budget_limited'].includes(row.status));
    const forbidden = await readFile(join(workspace, 'forbidden.txt')).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
    console.log(JSON.stringify({ type: 'completed', status: done.status, roleRevision: done.assistant?.revision, roleName: done.assistant?.name,
      oldInstructions: done.assistant?.instructions === 'ROLE_PIN_ORIGINAL_719', model: done.model.provider, latestRevision: (await runtime.assistants.get(state.assistantId!)).revision,
      forbidden, calls: await readFile(join(directory, 'model-calls.txt'), 'utf8') }));
  }
} finally { await runtime.close(); }
