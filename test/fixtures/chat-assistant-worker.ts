import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { LocalRuntime } from '../../src/runtime.js';
import { until } from '../helpers.js';

const [phase, dataDir, stage] = process.argv.slice(2) as [string, string, string];
const workspace = join(dataDir, 'workspace'), stateFile = join(dataDir, 'fixture.json');
const state: { chatId: string; roleId?: string } = phase === 'create' ? { chatId: '0dd13b9a-0302-4ef7-858d-14ad542b4e0b' } : JSON.parse(await readFile(stateFile, 'utf8'));
const created = stage === 'create-saved', operation = created ? 'assistant_create' : 'assistant_update';
const model = { provider: 'assistant-mutation-recovery', modelId: 'scripted' };
const provider = fauxProvider({ provider: model.provider, models: [{ id: model.modelId }] });
provider.setResponses(Array.from({ length: 8 }, () => async context => {
  await appendFile(join(dataDir, 'model-calls.txt'), 'model\n');
  if (context.messages.some(message => message.role === 'toolResult' && message.toolName === operation)) return fauxAssistantMessage('The original configuration operation has settled.');
  const patch = stage === 'archive-saved' ? { archived: true } : stage === 'noop-saved' ? { instructions: 'Original instructions.' } : { instructions: 'Chat amended instructions.' };
  return fauxAssistantMessage(fauxToolCall(operation, created ? { name: 'Original reader', instructions: 'Original instructions.', tools: ['read'] } :
    { id: state.roleId!, revision: 1, ...patch }), { stopReason: 'toolUse' });
}));
const models = createModels(); models.setProvider(provider.provider);
const runtime = new LocalRuntime({ dataDir, port: 4317, model, maxSubagents: 0, maxDurationMs: 600_000, review: false, discovery: false, web: false }, { models });
try {
  if (phase === 'create') {
    await mkdir(workspace);
    if (!created) state.roleId = (await runtime.assistants.create({ workspace, name: 'Original reader', instructions: 'Original instructions.', tools: ['read'] })).id;
    await writeFile(stateFile, JSON.stringify(state));
    if (created) {
      const create = runtime.assistants.create.bind(runtime.assistants);
      runtime.assistants.create = async (...args) => {
        const result = await create(...args); console.log(JSON.stringify({ type: 'ready', roleId: result.id }));
        await setTimeout(60_000); return result;
      };
    } else {
      const update = runtime.assistants.update.bind(runtime.assistants);
      runtime.assistants.update = async (...args) => {
        const result = stage === 'update-before' ? undefined : await update(...args);
        console.log(JSON.stringify({ type: 'ready', roleId: args[0] })); await setTimeout(60_000); return result ?? update(...args);
      };
    }
    await runtime.create('Save the requested assistant configuration only.', workspace, [], { chat: true, id: state.chatId });
    await setTimeout(60_000);
  } else {
    const [role] = await runtime.assistants.list(workspace);
    await runtime.assistants.update(role.id, { revision: role.revision, name: 'Later owner change', instructions: 'Later owner instructions.',
      tools: ['read', 'write'], archived: stage !== 'archive-saved' });
    await runtime.recover();
    const task = await until(() => runtime.status(state.chatId), row => ['answered', 'failed', 'budget_limited'].includes(row.status));
    const result = task.messages.find(message => message.role === 'toolResult' && message.toolName === operation);
    console.log(JSON.stringify({ type: 'completed', roles: await runtime.assistants.list(workspace), current: await runtime.assistants.get(role.id),
      goal: task.goal ?? null, assistantPin: task.assistant ?? null, tasks: (await runtime.list()).length,
      toolError: result?.role === 'toolResult' && result.isError,
      receipt: result?.role === 'toolResult' ? result.content.filter(block => block.type === 'text').map(block => block.text).join('') : null }));
  }
} finally { await runtime.close(); }
