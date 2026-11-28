import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { request as httpRequest, createServer } from 'node:http';
import type { request as HttpsRequest } from 'node:https';
import test from 'node:test';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { LocalRuntime } from '../src/runtime.js';
import { serve } from '../src/server.js';
import { createClient } from '../src/client.js';
import type { RoutineInput, RoutineHistoryRecord } from '../src/routines.js';
import type { RoutineHttpNetwork } from '../src/routine-http.js';
import { fakeRoutineClock, scriptedFixture, until } from './helpers.js';

const start = Date.UTC(2026, 10, 28, 11, 59), first = start + 60_000, day = 86_400_000;
const budget = { maxEstimatedCostUsd: 1, maxDurationMs: 30_000, maxTotalTokens: 10_000 };
const schedule = { kind: 'daily', time: '12:00', timeZone: 'UTC' } as const;
const precheck = { http: { url: 'https://status.example/status', track: ['id', 'updated'] } };

async function endpoint(t: test.TestContext) {
  const state = { body: '{"id":"service","updated":1,"content":"UNTRUSTED_HTTP_DATA_298"}', status: 200, calls: 0 };
  const server = createServer((_req, res) => { state.calls++; res.writeHead(state.status).end(state.body); });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); });
  const port = (server.address() as { port: number }).port;
  const network: RoutineHttpNetwork = { lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    request: ((options: any, callback: any) => httpRequest({ ...options, protocol: 'http:', hostname: '127.0.0.1', port, lookup: undefined }, callback)) as typeof HttpsRequest };
  return { state, network };
}

test('an HTTP rule baselines, recovers, ignores noise and only starts its original Pi task after a real change', async t => {
  const e = await endpoint(t), clock = fakeRoutineClock(start);
  let models = 0;
  const f = await scriptedFixture(context => {
    assert.doesNotMatch(JSON.stringify(context.messages), /UNTRUSTED_HTTP_DATA_298/);
    models++;
    return fauxAssistantMessage(fauxToolCall('task_submit', { summary: 'Original status-change task completed.', artifacts: [] }), { stopReason: 'toolUse' });
  }, {}, () => [], { routineHttp: e.network, routineClock: clock });
  let runtime = f.runtime;
  t.after(async () => { await runtime.close(); await f.close(); });
  const input = { id: 'public-http-change', action: 'task', objective: 'Inspect the original service change.', workspace: f.workspace,
    precheck, schedule, budget } satisfies RoutineInput;
  const rule = await runtime.routines.create(input);
  assert.deepEqual(rule.precheck, precheck);
  assert.equal(rule.overlapPolicy, 'skip');
  const slot = async (offset: number) => {
    const at = first + offset * day;
    await until(async () => clock.waitingAt(at), Boolean);
    clock.advanceTo(at);
    const history = await until(() => runtime.routines.history(rule.id), rows => rows.some(row => row.scheduledAt === new Date(at).toISOString() && row.status !== 'claimed'));
    return history.find(row => row.scheduledAt === new Date(at).toISOString() && row.status !== 'claimed')!;
  };
  const baseline = await slot(0);
  assert.equal(baseline.status, 'skipped');
  assert.equal(baseline.precheck?.status, 'baseline');
  assert.equal(models, 0);
  assert.equal(e.state.calls, 1);
  await runtime.close();
  runtime = new LocalRuntime(f.settings, { models: f.models, routineHttp: e.network, routineClock: clock });
  await runtime.recover();
  e.state.body = '{"noise":999,"updated":1,"id":"service"}';
  assert.equal((await slot(1)).precheck?.status, 'unchanged');
  e.state.status = 503;
  const failed = await slot(2);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.precheck?.status, 'failed');
  assert.equal(models, 0);
  e.state.status = 200;
  e.state.body = '{"id":"service","updated":2}';
  const changed = await slot(3);
  assert.equal(changed.status, 'started');
  assert.equal(changed.precheck?.status, 'changed');
  await until(() => runtime.status(changed.taskId!), row => row.status === 'completed');
  assert.equal(models, 1);
  assert.equal((await slot(4)).precheck?.status, 'unchanged');
  await runtime.routines.pause(rule.id);
  const pausedCalls = e.state.calls;
  clock.advanceTo(first + 5 * day);
  assert.equal(e.state.calls, pausedCalls);
  await runtime.routines.resume(rule.id);
  assert.equal((await slot(6)).precheck?.status, 'unchanged');
  assert.equal(models, 1);
  assert.doesNotMatch(JSON.stringify(await runtime.routines.history(rule.id)), /UNTRUSTED_HTTP_DATA_298/);
});

test('a changed HTTP sample is not consumed when task admission fails and Run now replays its original receipt', async t => {
  const e = await endpoint(t), clock = fakeRoutineClock(start);
  let models = 0;
  const f = await scriptedFixture(() => { models++; return fauxAssistantMessage(fauxToolCall('task_submit', { summary: 'Changed service checked.', artifacts: [] }), { stopReason: 'toolUse' }); },
    {}, () => [], { routineHttp: e.network, routineClock: clock });
  t.after(() => f.close());
  const runtime = f.runtime;
  const rule = await runtime.routines.create({ id: 'failed-http-admission', action: 'task', objective: 'Check the original change.', workspace: f.workspace,
    schedule, precheck, budget });
  const initial = await runtime.routines.runNow(rule.id, 'first-reading');
  await until(() => runtime.routines.history(rule.id), rows => rows.some(row => row.id === initial.id && row.status === 'skipped'));
  const create = runtime.create.bind(runtime);
  runtime.create = async () => { throw new Error('Synthetic admission refused.'); };
  e.state.body = '{"id":"service","updated":2}';
  const failure = await runtime.routines.runNow(rule.id, 'failed-reading');
  await until(() => runtime.routines.history(rule.id), rows => rows.some(row => row.id === failure.id && row.status === 'failed'));
  runtime.create = create;
  const retry = await runtime.routines.runNow(rule.id, 'retry-reading');
  await until(() => runtime.routines.history(rule.id), rows => rows.some(row => row.id === retry.id && row.status === 'started'));
  await until(() => runtime.status(retry.taskId!), row => row.status === 'completed');
  assert.equal(models, 1);
  const before = e.state.calls;
  assert.deepEqual(await runtime.routines.runNow(rule.id, 'retry-reading'), retry);
  assert.equal(e.state.calls, before);
  assert.equal((await runtime.routines.list())[0]!.nextRunAt, new Date(first).toISOString());
});

test('HTTP notification changes are delivered once while baselines and unchanged samples stay quiet', async t => {
  const e = await endpoint(t), clock = fakeRoutineClock(start);
  const f = await scriptedFixture(() => assert.fail('An HTTP notification must not call a model.'), {}, () => [], { routineHttp: e.network, routineClock: clock });
  let runtime = f.runtime;
  t.after(async () => { await runtime.close(); await f.close(); });
  const rule = await runtime.routines.create({ id: 'http-notification', action: 'notify', objective: 'The public service changed.', workspace: f.workspace,
    schedule, precheck });
  const run = async (key: string, status: RoutineHistoryRecord['status']) => {
    const receipt = await runtime.routines.runNow(rule.id, key);
    await until(() => runtime.routines.history(rule.id), rows => rows.some(row => row.id === receipt.id && row.status === status));
  };
  await run('baseline', 'skipped');
  assert.equal((await runtime.notifications()).length, 0);
  e.state.body = '{"id":"service","updated":2}';
  const inbox = runtime['inbox'], notify = inbox.notify.bind(inbox);
  inbox.notify = async () => { throw new Error('Synthetic notification write failed.'); };
  await run('failed-notice', 'failed');
  assert.equal((await runtime.notifications()).length, 0);
  inbox.notify = notify;
  await run('change', 'notified');
  assert.equal((await runtime.notifications()).length, 1);
  await runtime.close();
  runtime = new LocalRuntime(f.settings, { models: f.models, routineHttp: e.network, routineClock: clock });
  await runtime.recover();
  await run('unchanged', 'skipped');
  assert.equal((await runtime.notifications()).length, 1);
  assert.doesNotMatch(JSON.stringify(await runtime.notifications()), /UNTRUSTED_HTTP_DATA_298/);
});

for (const action of ['task', 'notify'] as const) for (const trigger of ['scheduled', 'manual'] as const) for (const effectSaved of [true, false]) test(`a paused ${trigger} HTTP ${action} uses the ${effectSaved ? 'saved' : 'missing'} host receipt after restart`, { timeout: 30_000 }, async t => {
  const e = await endpoint(t), clock = fakeRoutineClock(start);
  let models = 0;
  const f = await scriptedFixture(() => { models++; return fauxAssistantMessage(fauxToolCall('task_submit', { summary: 'Original change checked.', artifacts: [] }), { stopReason: 'toolUse' }); },
    {}, () => [], { routineHttp: e.network, routineClock: clock });
  let runtime = f.runtime;
  t.after(async () => { await runtime.close(); await f.close(); });
  const rule = await runtime.routines.create({ id: 'paused-http-effect', action, objective: 'Check the original public change.', workspace: f.workspace,
    schedule, precheck, ...(action === 'task' ? { budget } : {}) });
  const baseline = await runtime.routines.runNow(rule.id, 'seed-baseline');
  await until(() => runtime.routines.history(rule.id), rows => rows.some(row => row.id === baseline.id && row.status === 'skipped'));
  const applied = Promise.withResolvers<string | undefined>(), release = Promise.withResolvers<void>();
  const initial = runtime, create = runtime.create.bind(runtime), inbox = runtime['inbox'], notify = inbox.notify.bind(inbox);
  if (action === 'task') runtime.create = async (...args) => {
    const task = effectSaved ? await create(...args) : undefined;
    applied.resolve(task?.id); await release.promise;
    if (!task) throw new Error('Synthetic task was not admitted.');
    return task;
  };
  else inbox.notify = async (...args) => {
    if (effectSaved) await notify(...args);
    applied.resolve(undefined); await release.promise;
    if (!effectSaved) throw new Error('Synthetic notification was not saved.');
  };
  try {
    e.state.body = '{"id":"service","updated":2}';
    if (trigger === 'scheduled') { await until(async () => clock.waitingAt(first), Boolean); clock.advanceTo(first); }
    else await runtime.routines.runNow(rule.id, 'manual-change');
    const taskId = await applied.promise;
    if (taskId) await until(() => runtime.status(taskId), row => row.status === 'completed');
    await runtime.routines.pause(rule.id);
    release.resolve(); runtime.create = create; inbox.notify = notify;
    await runtime.close();
    runtime = new LocalRuntime(f.settings, { models: f.models, routineHttp: e.network, routineClock: clock });
    await runtime.recover();
    await runtime.routines.resume(rule.id);
    if (action === 'notify' && trigger === 'manual' && effectSaved) {
      const options = runtime.routines['options'], read = options.httpApplied;
      options.httpApplied = async () => { throw new Error('Receipt lookup failed: synthetic-private-url'); };
      const failed = await runtime.routines.runNow(rule.id, 'unavailable-receipt');
      const errors = await until(() => runtime.routines.history(rule.id), rows => rows.some(row => row.id === failed.id && row.status === 'failed'));
      assert.doesNotMatch(JSON.stringify(errors.find(row => row.id === failed.id && row.status === 'failed')), /synthetic-private-url/);
      options.httpApplied = read;
    }
    const next = trigger === 'scheduled' ? first + day : first;
    await until(async () => clock.waitingAt(next), Boolean);
    clock.advanceTo(next);
    const history = await until(() => runtime.routines.history(rule.id), rows => rows.some(row => row.scheduledAt === new Date(next).toISOString() && row.status !== 'claimed'));
    const resumed = history.find(row => row.scheduledAt === new Date(next).toISOString() && row.status !== 'claimed')!;
    assert.equal(resumed.precheck?.status, effectSaved ? 'unchanged' : 'changed');
    if (resumed.status === 'started') await until(() => runtime.status(resumed.taskId!), row => row.status === 'completed');
    assert.equal(models, action === 'task' ? 1 : 0);
    assert.equal((await runtime.notifications()).filter(row => row.event === 'reminder').length, action === 'notify' ? 1 : 0);
  } finally { release.resolve(); initial.create = create; inbox.notify = notify; }
});

test('HTTP watch configuration rejects unsupported or ambiguous schedules without affecting existing rules', async t => {
  const f = await scriptedFixture(() => assert.fail('Invalid configuration cannot call the model.'));
  t.after(() => f.close());
  const input = { action: 'task', objective: 'Check public content.', workspace: f.workspace, schedule, precheck, budget };
  for (const invalid of [{ ...input, workspace: undefined }, { ...input, schedule: { kind: 'once', at: new Date(Date.now() + 60_000).toISOString() } },
    { ...input, schedule: { kind: 'event' }, event: { source: 'fixture', type: 'changed', equals: { ready: true } } },
    { ...input, precheck: { ...precheck, command: ['echo', 'ignored'] } }, { ...input, precheck: { http: { ...precheck.http, headers: { Authorization: 'forbidden' } } } }]) {
    await assert.rejects(f.runtime.routines.create(invalid as RoutineInput), /precheck|HTTP|recurring|workspace/i);
  }
  assert.deepEqual(await f.runtime.routines.list(), []);
});

for (const action of ['cancel', 'update'] as const) test(`a ${action} during HTTP DNS resolution prevents the old occurrence from dispatching or saving a baseline`, async t => {
  const e = await endpoint(t), clock = fakeRoutineClock(start);
  const dns = Promise.withResolvers<{ address: string; family: number }[]>(), entered = Promise.withResolvers<void>();
  let firstLookup = true;
  const network: RoutineHttpNetwork = { ...e.network, lookup: async () => {
    if (!firstLookup) return [{ address: '8.8.8.8', family: 4 }];
    firstLookup = false; entered.resolve(); return dns.promise;
  } };
  const f = await scriptedFixture(() => assert.fail('A stale HTTP occurrence must not start a model.'), {}, () => [], { routineHttp: network, routineClock: clock });
  t.after(() => f.close());
  const runtime = f.runtime, input = { id: 'stale-http', action: 'task', objective: 'Check the original public status.', workspace: f.workspace, precheck, schedule, budget } as const;
  const rule = await runtime.routines.create(input);
  await until(async () => clock.waitingAt(first), Boolean);
  clock.advanceTo(first);
  await entered.promise;
  if (action === 'cancel') await runtime.routines.cancel(rule.id);
  else await runtime.routines.update(rule.id, { ...input, objective: 'Check the revised public status.' });
  dns.resolve([{ address: '8.8.8.8', family: 4 }]);
  assert.equal(e.state.calls, 0);
  assert.equal((await runtime.list()).length, 0);
  if (action === 'update') {
    const next = first + day;
    await until(async () => clock.waitingAt(next), Boolean);
    clock.advanceTo(next);
    const history = await until(() => runtime.routines.history(rule.id), rows => rows.some(row => row.revision === 2 && row.status === 'skipped'));
    assert.equal(history.find(row => row.revision === 2 && row.status === 'skipped')!.precheck?.status, 'baseline');
    assert.equal(e.state.calls, 1);
  } else assert.equal((await runtime.routines.list())[0]!.status, 'cancelled');
});

test('an inactive HTTP rule performs no DNS or model work while explicit Run now still baselines', async t => {
  const e = await endpoint(t), clock = fakeRoutineClock(start);
  const f = await scriptedFixture(() => assert.fail('An inactive or baselining rule must not call a model.'), {}, () => [], { routineHttp: e.network, routineClock: clock });
  t.after(() => f.close());
  const runtime = f.runtime;
  const rule = await runtime.routines.create({ id: 'inactive-http', action: 'task', objective: 'Check when the project is active.', workspace: f.workspace,
    precheck, schedule, budget, activity: { withinMinutes: 5, minIntervalMinutes: 5 } });
  await until(async () => clock.waitingAt(first), Boolean);
  clock.advanceTo(first);
  const history = await until(() => runtime.routines.history(rule.id), rows => rows.some(row => row.status === 'skipped'));
  assert.equal(history.find(row => row.status === 'skipped')!.activity?.status, 'inactive');
  assert.equal(e.state.calls, 0);
  const requested = await runtime.routines.runNow(rule.id, 'explicit-baseline');
  const manual = await until(() => runtime.routines.history(rule.id), rows => rows.some(row => row.id === requested.id && row.status === 'skipped'));
  assert.equal(manual.find(row => row.id === requested.id && row.status === 'skipped')!.precheck?.status, 'baseline');
  assert.equal(e.state.calls, 1);
});

test('the owner CLI and API save an HTTP watch and deliver one original verified file after a change', async t => {
  const e = await endpoint(t), clock = fakeRoutineClock(start);
  let models = 0;
  const f = await scriptedFixture(context => {
    assert.doesNotMatch(JSON.stringify(context.messages), /UNTRUSTED_HTTP_DATA_298/);
    models++;
    const written = context.messages.some(message => message.role === 'toolResult' && message.toolName === 'write');
    return fauxAssistantMessage(fauxToolCall(written ? 'task_submit' : 'write', written
      ? { summary: 'Original HTTP change checked.', artifacts: ['status-result.txt'] }
      : { path: 'status-result.txt', content: 'Verified original status-change task.' }), { stopReason: 'toolUse' });
  });
  await f.runtime.close();
  const listener = createServer();
  await new Promise<void>(done => listener.listen(0, '127.0.0.1', done));
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>(done => listener.close(() => done()));
  const config = { ...f.settings, port }, host = await serve(config, { models: f.models, routineClock: clock, routineHttp: e.network });
  t.after(async () => { await host.close(); await f.close(); });
  const configFile = join(f.directory, 'http-watch-config.json'), inputFile = join(f.directory, 'http-watch-rule.json');
  await writeFile(configFile, JSON.stringify(config));
  await writeFile(inputFile, JSON.stringify({ id: 'cli-http-watch', action: 'task', objective: 'Check the original public status change.', workspace: f.workspace,
    schedule, precheck, budget }));
  const cli = async (...args: string[]) => JSON.parse((await promisify(execFile)(process.execPath,
    ['--import', 'tsx', 'src/cli.ts', 'routines', ...args, '--config', configFile], { cwd: process.cwd() })).stdout);
  const rule = await cli('add', inputFile);
  assert.deepEqual(rule.precheck, precheck);
  const baseline = await cli('run', rule.id, 'first-baseline');
  await until(() => host.runtime.routines.history(rule.id), rows => rows.some(row => row.id === baseline.id && row.status === 'skipped'));
  assert.equal(models, 0);
  e.state.body = '{"id":"service","updated":2}';
  const changed = await cli('run', rule.id, 'original-change');
  await until(() => host.runtime.routines.history(rule.id), rows => rows.some(row => row.id === changed.id && row.status === 'started'));
  const done = await until(() => host.runtime.status(changed.taskId), row => ['completed', 'failed'].includes(row.status));
  assert.equal(done.status, 'completed');
  assert.equal(await readFile(join(f.workspace, 'status-result.txt'), 'utf8'), 'Verified original status-change task.');
  assert.equal(models, 2);
  assert.equal((await host.runtime.list()).length, 1);
  assert.deepEqual(await cli('run', rule.id, 'original-change'), changed);
  const history = await createClient(config).request<RoutineHistoryRecord[]>('/v1/routines/' + rule.id + '/occurrences');
  assert(history.some(row => row.precheck?.status === 'baseline'));
  assert(history.some(row => row.precheck?.status === 'changed' && row.taskId === done.id));
});
