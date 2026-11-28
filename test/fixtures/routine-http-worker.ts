import assert from 'node:assert/strict';
import { appendFile, mkdir } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import type { request as HttpsRequest } from 'node:https';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { defineExtension, wrapTool } from '@earendil-works/pi-durable';
import { createWriteTool } from '@earendil-works/pi-durable/tools';
import { LocalRuntime } from '../../src/runtime.js';
import { fakeRoutineClock, until } from '../helpers.js';

const [mode, directory, scenario] = process.argv.slice(2) as ['create' | 'recover', string, 'baseline' | 'admitted'];
const first = Date.UTC(2026, 10, 28, 12), day = 86_400_000;
const workspace = join(directory, 'workspace');
const clock = fakeRoutineClock(mode === 'create' ? first - 60_000 : scenario === 'baseline' ? first + 60_000 : first + day + 60_000);
let updated = scenario === 'admitted' && mode === 'recover' ? 2 : 1, requests = 0, modelRequests = 0;
const server = createServer((_req, res) => { requests++; res.end(JSON.stringify({ id: 'service', updated })); });
await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
const port = (server.address() as { port: number }).port;
const provider = fauxProvider({ provider: 'http-watch-recovery', models: [{ id: 'scripted' }] });
const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' });
provider.setResponses(Array.from({ length: 24 }, () => context => {
  modelRequests++;
  assert.equal(scenario, 'admitted');
  const results = context.messages.filter(message => message.role === 'toolResult');
  const attempted = results.find(result => result.toolName === 'write');
  if (!attempted) return call('write', { path: 'result.txt', content: 'ORIGINAL_HTTP_WATCH_RESULT_73' });
  assert.equal(attempted.isError, true, 'An unacknowledged write must remain interrupted.');
  const read = results.find(result => result.toolName === 'read');
  if (!read) return call('read', { path: 'result.txt' });
  assert.match(JSON.stringify(read), /ORIGINAL_HTTP_WATCH_RESULT_73/);
  return call('task_submit', { summary: 'Observed the existing result after restart.', artifacts: ['result.txt'] });
}));
const models = createModels(); models.setProvider(provider.provider);
const effect = defineExtension({ name: 'http_watch_effect_fixture', wraps: [wrapTool(createWriteTool(), original => ({ ...original,
  execute: async (args, api, context) => {
    const result = await original.execute(args, api, context);
    await appendFile(join(workspace, 'effects.txt'), 'effect\n');
    console.log(JSON.stringify({ type: 'ready' }));
    await setTimeout(60_000, undefined, { signal: context.abortSignal });
    return result;
  },
}))] });
const runtime = new LocalRuntime({ dataDir: directory, port: 4317, model: { provider: provider.provider.id, modelId: 'scripted' },
  maxSubagents: 1, maxDurationMs: 60_000, web: false, review: false, discovery: false }, {
  models, routineClock: clock, extensions: [effect], routineHttp: {
    lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    request: ((options: any, callback: any) => httpRequest({ ...options, protocol: 'http:', hostname: '127.0.0.1', port, lookup: undefined }, callback)) as typeof HttpsRequest,
  },
});
const ruleId = 'http-watch-recovery';
try {
  if (mode === 'create') {
    await mkdir(workspace);
    if (scenario === 'admitted') {
      const create = runtime.create.bind(runtime);
      runtime.create = async (...args) => { const task = await create(...args); await setTimeout(60_000, undefined, { signal: args[3]?.signal }); return task; };
    }
    await runtime.routines.create({ id: ruleId, action: 'task', workspace, objective: 'Record the original changed service result.',
      schedule: { kind: 'daily', time: '12:00', timeZone: 'UTC' }, precheck: { http: { url: 'https://status.example/status', track: ['id', 'updated'] } },
      budget: { maxEstimatedCostUsd: 1, maxDurationMs: 60_000, maxTotalTokens: 20_000 } });
    await until(async () => clock.waitingAt(first), Boolean);
    clock.advanceTo(first);
    await until(() => runtime.routines.history(ruleId), rows => rows.some(row => row.precheck?.status === 'baseline' && row.status === 'skipped'));
    assert.equal(modelRequests, 0);
    if (scenario === 'baseline') console.log(JSON.stringify({ type: 'ready' }));
    else {
      updated = 2;
      await until(async () => clock.waitingAt(first + day), Boolean);
      clock.advanceTo(first + day);
    }
    await setTimeout(60_000);
  } else {
    await runtime.recover();
    if (scenario === 'baseline') {
      await until(async () => clock.waitingAt(first + day), Boolean);
      clock.advanceTo(first + day);
      const history = await until(() => runtime.routines.history(ruleId), rows => rows.some(row => row.precheck?.status === 'unchanged'));
      assert.equal(modelRequests, 0);
      assert.equal((await runtime.list()).length, 0);
      console.log(JSON.stringify({ type: 'completed', statuses: history.filter(row => row.status !== 'claimed').map(row => row.precheck?.status), modelRequests, requests }));
    } else {
      const history = await until(() => runtime.routines.history(ruleId), rows => rows.some(row => row.status === 'started'));
      const [task] = await runtime.list(); assert(task);
      const done = await until(() => runtime.status(task.id), row => ['completed', 'failed'].includes(row.status));
      assert.equal(done.status, 'completed', JSON.stringify(done.submission));
      assert.equal(requests, 0, 'A saved precheck receipt must not refetch after restart.');
      console.log(JSON.stringify({ type: 'completed', tasks: (await runtime.list()).map(row => row.id),
        history: history.filter(row => row.scheduledAt === new Date(first + day).toISOString()).map(row => [row.status, row.taskId]), requests, modelRequests }));
    }
  }
} finally { await runtime.close(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
