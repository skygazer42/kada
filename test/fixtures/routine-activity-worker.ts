import assert from 'node:assert/strict';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { LocalRuntime } from '../../src/runtime.js';
import { fakeRoutineClock, until } from '../helpers.js';

const [mode, dataDir] = process.argv.slice(2) as ['create' | 'recover', string];
const workspace = join(dataDir, 'workspace'), atFile = join(dataDir, 'due.txt');
const due = mode === 'create' ? Date.now() + 60_000 : Number(await readFile(atFile, 'utf8'));
const clock = fakeRoutineClock(mode === 'create' ? due - 60_000 : due + 2 * 60_000);
const model = { provider: 'activity-fixture', modelId: 'scripted' };
const provider = fauxProvider({ provider: model.provider, models: [{ id: model.modelId }] });
provider.setResponses(Array.from({ length: 8 }, () => async () => {
  await appendFile(join(dataDir, 'model-calls.txt'), 'model\n');
  return fauxAssistantMessage(fauxToolCall('task_submit', { summary: 'Project checked.', artifacts: [] }), { stopReason: 'toolUse' });
}));
const models = createModels(); models.setProvider(provider.provider);
const runtime = new LocalRuntime({ dataDir, port: 4317, model, maxSubagents: 1, maxDurationMs: 600_000, web: false, review: false, discovery: false },
  { models, routineClock: clock });

try {
  if (mode === 'create') {
    await mkdir(workspace);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(atFile, String(due));
    const direct = await runtime.create('A local user request.', workspace);
    await until(() => runtime.status(direct.id), status => status.status === 'completed');
    const create = runtime.create.bind(runtime);
    runtime.create = async (...args) => {
      const task = await create(...args);
      if (args[3]?.routineOccurrenceId) {
        await until(() => runtime.status(task.id), status => status.status === 'completed');
        console.log(JSON.stringify({ type: 'ready', taskId: task.id, createdAt: task.createdAt }));
        await setTimeout(60_000, undefined, { signal: args[3].signal });
      }
      return task;
    };
    await runtime.routines.create({ id: 'activity', action: 'task', workspace, objective: 'Check the approved project.',
      schedule: { kind: 'interval', anchorAt: new Date(due).toISOString(), everyMinutes: 5 }, missedPolicy: 'run_once',
      activity: { withinMinutes: 1, minIntervalMinutes: 15 } });
    await until(async () => clock.waitingAt(due), Boolean); clock.advanceTo(due);
    await setTimeout(60_000);
  } else {
    let queries = 0;
    runtime.lastUserActivity = async () => { queries++; return undefined; };
    await runtime.recover();
    const history = await until(() => runtime.routines.history('activity'), rows => rows.some(row => row.status === 'started'));
    const first = history.find(row => row.status === 'started')!;
    const task = await runtime.status(first.taskId!);
    assert.equal(task.status, 'completed');
    assert.equal(queries, 0, 'The saved allowed decision must not be reevaluated during replay.');
    await until(async () => clock.waitingAt(due + 5 * 60_000), Boolean); clock.advanceTo(due + 5 * 60_000);
    const final = await until(() => runtime.routines.history('activity'), rows => rows.some(row => row.activity?.status === 'cooldown'));
    console.log(JSON.stringify({ type: 'completed', history: history.map(row => [row.status, row.activity?.status, row.taskId]),
      taskId: task.id, startedAt: first.startedAt, createdAt: task.createdAt, tasks: (await runtime.list()).length, queries,
      cooldown: final.find(row => row.activity?.status === 'cooldown')?.status }));
  }
} finally { await runtime.close(); }
