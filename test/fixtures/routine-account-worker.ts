import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { createModels, fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { LocalRuntime } from '../../src/runtime.js';
import { fakeRoutineClock, until } from '../helpers.js';

const [mode, dataDir] = process.argv.slice(2) as ['create' | 'recover', string];
const workspace = join(dataDir, 'workspace'), atPath = join(dataDir, 'due.txt');
const due = mode === 'create' ? Date.now() + 60_000 : Number(await readFile(atPath, 'utf8'));
const clock = fakeRoutineClock(mode === 'create' ? due - 60_000 : due + 10 * 60_000);
const model = { provider: 'account-fixture', modelId: 'scripted' };
const faux = fauxProvider({ provider: model.provider, models: [{ id: model.modelId }] });
faux.setResponses(Array.from({ length: 8 }, () => async () => {
  await appendFile(join(dataDir, 'calls.txt'), 'model\n');
  return { ...fauxAssistantMessage('', { stopReason: 'error', errorMessage: '401 Unauthorized: synthetic invalid API key' }), timestamp: clock.now() };
}));
const models = createModels(); models.setProvider(faux.provider);
const runtime = new LocalRuntime({ dataDir, port: 4317, model, maxSubagents: 1, maxDurationMs: 600_000, web: false, review: false, discovery: false },
  { models, routineClock: clock });
try {
  if (mode === 'create') {
    await mkdir(workspace); await writeFile(atPath, String(due));
    await runtime.routines.create({ id: 'account', action: 'task', objective: 'Check the approved project', workspace,
      schedule: { kind: 'interval', anchorAt: new Date(due).toISOString(), everyMinutes: 5 }, accountBackoff: true, missedPolicy: 'run_once' });
    for (const at of [due, due + 5 * 60_000]) {
      await until(async () => clock.waitingAt(at), Boolean); clock.advanceTo(at);
      const receipt = await until(async () => (await runtime.routines.history('account')).find(row => row.status === 'started' && row.scheduledAt === new Date(at).toISOString()), Boolean);
      await until(() => runtime.status(receipt!.taskId!), status => status.status === 'failed');
    }
    console.log(JSON.stringify({ type: 'ready', due }));
    await setTimeout(60_000);
  } else {
    await runtime.recover();
    const history = await until(() => runtime.routines.history('account'), rows => rows.some(row => row.accountCooldown?.failures === 2));
    const skip = history.find(row => row.accountCooldown?.failures === 2)!;
    console.log(JSON.stringify({ type: 'completed', cooldown: skip.accountCooldown, status: skip.status, tasks: (await runtime.list()).length }));
  }
} finally { await runtime.close(); }
