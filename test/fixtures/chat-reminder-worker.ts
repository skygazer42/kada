import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { LocalRuntime } from '../../src/runtime.js';
import { fakeRoutineClock, until } from '../helpers.js';

const [mode, dataDir, scenario] = process.argv.slice(2) as ['create' | 'recover', string, 'create' | 'cancel' | 'cancel-saved'];
const operation = scenario === 'create' ? 'create' : 'cancel';
const statePath = join(dataDir, 'fixture.json'), workspace = join(dataDir, 'workspace');
const state = mode === 'create' ? { chatId: 'efaa9b34-24ba-423c-8411-a56512eb1bfe', due: Date.now() + 60_000 } :
  JSON.parse(await readFile(statePath, 'utf8')) as { chatId: string; due: number };
const clock = fakeRoutineClock(mode === 'create' ? state.due - 60_000 : state.due + 60_000);
const model = { provider: 'reminder-fixture', modelId: 'scripted' };
const faux = fauxProvider({ provider: model.provider, models: [{ id: model.modelId }] });
faux.setResponses(Array.from({ length: 8 }, () => async context => {
  await appendFile(join(dataDir, 'model-calls.txt'), 'model\n');
  if (context.messages.some(message => message.role === 'toolResult' && message.toolName === 'reminder_' + operation)) return fauxAssistantMessage('Reminder handled.');
  return fauxAssistantMessage(fauxToolCall('reminder_' + operation, operation === 'create' ?
    { at: new Date(state.due).toISOString(), note: 'Check the report' } : { id: 'cancel-target', revision: 1 }), { stopReason: 'toolUse' });
}));
const models = createModels(); models.setProvider(faux.provider);
const runtime = new LocalRuntime({ dataDir, port: 4317, model, maxSubagents: 1, maxDurationMs: 600_000, review: false, discovery: false, web: false },
  { models, routineClock: clock });
try {
  if (mode === 'create') {
    await mkdir(workspace); await writeFile(statePath, JSON.stringify(state));
    if (operation === 'create') {
      const create = runtime.routines.create.bind(runtime.routines);
      runtime.routines.create = async (...args) => {
        const result = await create(...args);
        console.log(JSON.stringify({ type: 'ready', reminderId: result.id }));
        await setTimeout(60_000); return result;
      };
    } else {
      await runtime.routines.create({ id: 'cancel-target', action: 'notify', objective: 'Old reminder', workspace,
        schedule: { kind: 'once', at: new Date(state.due).toISOString() } });
      const cancel = runtime.routines.cancel.bind(runtime.routines);
      runtime.routines.cancel = async (...args) => {
        const result = scenario === 'cancel-saved' ? await cancel(...args) : undefined;
        console.log(JSON.stringify({ type: 'ready', reminderId: args[0] }));
        await setTimeout(60_000); return result ?? cancel(...args);
      };
    }
    await runtime.create('Please ' + operation + ' my reminder.', workspace, [], { chat: true, id: state.chatId });
    await setTimeout(60_000);
  } else {
    if (scenario === 'cancel') await runtime.routines.update('cancel-target', { action: 'notify', objective: 'New reminder while cancellation was interrupted', workspace,
      schedule: { kind: 'once', at: new Date(state.due + 3600_000).toISOString() } });
    await runtime.recover();
    const chat = await until(() => runtime.status(state.chatId), status => status.status === 'answered');
    const rules = await runtime.routines.list();
    if (operation === 'create') await until(() => runtime.notifications(), rows => rows.some(row => row.routineId === rules[0]?.id));
    const result = chat.messages.find(message => message.role === 'toolResult' && message.toolName === 'reminder_' + operation);
    console.log(JSON.stringify({ type: 'completed', rules: await runtime.routines.list(), goal: chat.goal ?? null,
      notifications: await runtime.notifications(), toolError: result?.role === 'toolResult' && result.isError === true }));
  }
} finally { await runtime.close(); }
