import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { LocalRuntime } from '../../src/runtime.js';
import { until } from '../helpers.js';

const [mode, dataDir, scenario] = process.argv.slice(2) as [string, string, string];
const workspace = join(dataDir, 'workspace'), statePath = join(dataDir, 'fixture.json');
const state: { chatId: string; itemId?: string } = mode === 'create' ? { chatId: 'ecbe6fb2-65f1-4b1c-b359-3ccb405a6bd4' } : JSON.parse(await readFile(statePath, 'utf8'));
const operation = scenario.endsWith('create-saved') ? 'work_item_create' : 'work_item_update';
const planned = scenario.startsWith('planning-');
const model = { provider: 'work-item-fixture', modelId: 'scripted' };
const faux = fauxProvider({ provider: model.provider, models: [{ id: model.modelId }] });
faux.setResponses(Array.from({ length: 8 }, () => async context => {
  await appendFile(join(dataDir, 'model-calls.txt'), 'model\n');
  if (context.messages.some(message => message.role === 'toolResult' && message.toolName === operation)) return fauxAssistantMessage('Saved operation handled.');
  return fauxAssistantMessage(fauxToolCall(operation, operation === 'work_item_create' ? { title: 'Chat saved', objective: 'Original requested todo',
    ...(planned ? { priority: 'high', dueDate: '2026-12-01', timeZone: 'America/New_York' } : {}) } :
    scenario === 'archive-saved' ? { id: state.itemId!, revision: 1, status: 'done', archived: true } :
      { id: state.itemId!, revision: 1, title: 'Chat updated', status: 'parked',
        ...(planned ? { priority: 'urgent', dueAt: '2026-12-02T17:00:00-05:00', timeZone: 'America/New_York' } : {}) }), { stopReason: 'toolUse' });
}));
const models = createModels(); models.setProvider(faux.provider);
const runtime = new LocalRuntime({ dataDir, port: 4317, model, maxSubagents: 0, maxDurationMs: 600_000, review: false, discovery: false, web: false }, { models });
try {
  if (mode === 'create') {
    await mkdir(workspace);
    if (operation === 'work_item_update') state.itemId = (await runtime.workItems.create({ workspace, title: 'Original', objective: 'Original requested todo' })).id;
    await writeFile(statePath, JSON.stringify(state));
    if (operation === 'work_item_create') {
      const create = runtime.workItems.create.bind(runtime.workItems);
      runtime.workItems.create = async (...args) => {
        const result = await create(...args);
        console.log(JSON.stringify({ type: 'ready', itemId: result.id }));
        await setTimeout(60_000); return result;
      };
    } else {
      const update = runtime.workItems.update.bind(runtime.workItems);
      runtime.workItems.update = async (...args) => {
        const result = scenario === 'update-before' ? undefined : await update(...args);
        console.log(JSON.stringify({ type: 'ready', itemId: args[0] }));
        await setTimeout(60_000); return result ?? update(...args);
      };
    }
    await runtime.create('Save the requested todo change.', workspace, [], { chat: true, id: state.chatId });
    await setTimeout(60_000);
  } else {
    const [item] = await runtime.workItems.list(workspace);
    await runtime.workItems.update(item.id, { revision: item.revision, title: 'Later owner change',
      ...(planned ? { priority: 'low', dueDate: '2030-01-02', dueAt: null, timeZone: 'Asia/Tokyo' } : {}),
      ...(scenario === 'archive-saved' ? { status: 'open', archived: false } : { status: 'done', archived: true }) });
    await runtime.recover();
    const chat = await until(() => runtime.status(state.chatId), row => row.status === 'answered');
    const result = chat.messages.find(message => message.role === 'toolResult' && message.toolName === operation);
    console.log(JSON.stringify({ type: 'completed', items: await runtime.workItems.list(workspace), goal: chat.goal ?? null,
      runs: await runtime.workItems.runs(item.id), toolError: result?.role === 'toolResult' && result.isError,
      result: result?.role === 'toolResult' ? result.content.filter(block => block.type === 'text').map(block => block.text).join('') : null }));
  }
} finally { await runtime.close(); }
