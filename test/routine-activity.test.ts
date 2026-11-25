import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { LocalRoutines, type RoutineInput, type RoutineOccurrence } from '../src/routines.js';
import { LocalRuntime } from '../src/runtime.js';
import { serve } from '../src/server.js';
import { createClient } from '../src/client.js';
import { createServer } from 'node:net';
import { changeGoal } from '../src/goal.js';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { fakeRoutineClock, scriptedFixture, until } from './helpers.js';

const start = Date.parse('2026-11-25T00:00:00Z');
const minute = 60_000;
const rule = {
  id: 'check-in', action: 'task', objective: 'Review the approved project checklist',
  schedule: { kind: 'interval', anchorAt: new Date(start + minute).toISOString(), everyMinutes: 5 },
  missedPolicy: 'run_once',
  activity: { withinMinutes: 30, minIntervalMinutes: 15 },
} satisfies RoutineInput;

async function directory(t: TestContext) {
  const path = await mkdtemp(join(tmpdir(), 'kada-activity-'));
  t.after(() => rm(path, { recursive: true, force: true, maxRetries: 5 }));
  return path;
}

test('activity and cooldown skip before precheck, while manual runs and reopen preserve the original start interval', async t => {
  const dataDir = await directory(t), clock = fakeRoutineClock(start);
  let lastUserAt: number | undefined;
  const calls: RoutineOccurrence[] = [];
  const options = { dataDir, ...clock, lastUserActivity: async () => lastUserAt,
    execute: async (occurrence: RoutineOccurrence) => { calls.push(occurrence); return { taskId: occurrence.taskId }; } };
  let routines = new LocalRoutines(options);
  const input = { ...rule, workspace: dataDir, precheck: { command: [process.execPath, '-e', "require('node:fs').appendFileSync('samples.txt','sample\\n'); console.log(Date.now())"] } };
  const slot = async (at: number) => {
    await until(async () => {
      const next = (await routines.list())[0]?.nextRunAt;
      return next !== undefined && clock.waitingAt(Date.parse(next));
    }, Boolean);
    clock.advanceTo(at);
    return until(async () => (await routines.history(rule.id)).find(row => row.scheduledAt === new Date(at).toISOString() && row.status !== 'claimed'), Boolean);
  };
  try {
    await routines.create(input);
    const inactive = await slot(start + minute);
    assert.equal(inactive?.status, 'skipped');
    assert.equal(inactive?.activity?.status, 'inactive');
    await assert.rejects(readFile(join(dataDir, 'samples.txt')), { code: 'ENOENT' });
    assert.equal(calls.length, 0);
    lastUserAt = start + minute;
    const active = await slot(start + 6 * minute);
    assert.equal(active?.status, 'started');
    assert.equal(active?.activity?.status, 'allowed');
    assert.equal(calls.length, 1);
    await routines.close(); routines = new LocalRoutines(options); await routines.recover();
    const cooldown = await slot(start + 11 * minute);
    assert.equal(cooldown?.activity?.status, 'cooldown');
    assert.equal(cooldown?.status, 'skipped');
    assert.equal(await readFile(join(dataDir, 'samples.txt'), 'utf8'), 'sample\n');
    await routines.update(rule.id, { ...input, objective: 'Review the revised checklist' });
    assert.equal((await slot(start + 16 * minute))?.activity?.status, 'cooldown');
    const manual = await routines.runNow(rule.id, 'manual-intent');
    const manualResult = await until(async () => (await routines.history(rule.id)).find(row => row.id === manual.id && row.status !== 'claimed'), Boolean);
    assert.equal(manualResult?.status, 'started');
    assert.equal(manualResult?.activity, undefined);
    assert.equal(calls.length, 2);
    await routines.pause(rule.id); await routines.resume(rule.id);
    assert.equal((await slot(start + 21 * minute))?.activity?.status, 'cooldown');
    lastUserAt = start + 30 * minute;
    assert.equal((await slot(start + 31 * minute))?.status, 'started');
    assert.equal(calls.length, 3);
    assert.equal((await routines.list())[0]?.overlapPolicy, 'skip');
  } finally { await routines.close(); }
});

test('activity lookup failure and stale activity do not execute, and failed admission does not consume the interval', async t => {
  const dataDir = await directory(t), clock = fakeRoutineClock(start);
  let failLookup = true, failAdmission = true, lastUserAt = start;
  const calls: RoutineOccurrence[] = [];
  const routines = new LocalRoutines({ dataDir, ...clock,
    lastUserActivity: async () => { if (failLookup) throw new Error('Synthetic lookup failure'); return lastUserAt; },
    execute: async occurrence => { if (failAdmission) throw new Error('Synthetic admission failure'); calls.push(occurrence); return { taskId: occurrence.taskId }; },
  });
  const slot = async (at: number) => {
    await until(async () => {
      const next = (await routines.list())[0]?.nextRunAt;
      return next !== undefined && clock.waitingAt(Date.parse(next));
    }, Boolean); clock.advanceTo(at);
    return until(async () => (await routines.history(rule.id)).find(row => row.scheduledAt === new Date(at).toISOString() && row.status !== 'claimed'), Boolean);
  };
  try {
    await routines.create({ ...rule, workspace: dataDir });
    const failed = await slot(start + minute);
    assert.equal(failed?.status, 'failed'); assert.equal(failed?.activity?.status, 'failed');
    failLookup = false;
    const admission = await slot(start + 6 * minute);
    assert.equal(admission?.status, 'failed'); assert.equal(admission?.activity?.status, 'allowed');
    failAdmission = false;
    assert.equal((await slot(start + 11 * minute))?.status, 'started');
    lastUserAt = start - 60 * minute;
    assert.equal((await slot(start + 31 * minute))?.activity?.status, 'inactive');
    assert.equal(calls.length, 1);
  } finally { await routines.close(); }
});

test('activity rules reject missing workspace, nonrecurring actions and malformed limits', async t => {
  const dataDir = await directory(t), routines = new LocalRoutines({ dataDir, execute: async () => ({ status: 'notified' }) });
  try {
    for (const invalid of [rule, { ...rule, workspace: dataDir, action: 'notify' },
      { ...rule, workspace: dataDir, schedule: { kind: 'once', at: new Date(start + minute).toISOString() } },
      { ...rule, workspace: dataDir, event: { source: 'test', type: 'changed', equals: { ok: true } } },
      { ...rule, workspace: dataDir, activity: { withinMinutes: 0, minIntervalMinutes: 1 } },
      { ...rule, workspace: dataDir, activity: { withinMinutes: 1, minIntervalMinutes: 43_201 } },
      { ...rule, workspace: dataDir, activity: { withinMinutes: 1.5, minIntervalMinutes: 1 } },
      { ...rule, workspace: dataDir, activity: { withinMinutes: 1, minIntervalMinutes: 1, other: true } },
    ]) await assert.rejects(routines.create(invalid as RoutineInput), { status: 400 });
  } finally { await routines.close(); }
});

test('a pause during activity lookup cancels admission and ignores a late allowed result', async t => {
  const dataDir = await directory(t), clock = fakeRoutineClock(start);
  const queried = Promise.withResolvers<void>(), activity = Promise.withResolvers<number>();
  let calls = 0;
  const routines = new LocalRoutines({ dataDir, ...clock,
    lastUserActivity: async () => { queried.resolve(); return activity.promise; },
    execute: async occurrence => { calls++; return { taskId: occurrence.taskId }; },
  });
  try {
    await routines.create({ ...rule, workspace: dataDir });
    await until(async () => clock.waitingAt(start + minute), Boolean); clock.advanceTo(start + minute);
    await queried.promise;
    await routines.pause(rule.id);
    activity.resolve(start);
    await routines.close();
    assert.equal(calls, 0);
    const reopened = new LocalRoutines({ dataDir, ...clock, execute: async () => assert.fail('A paused rule cannot start a task') });
    try {
      await reopened.recover();
      assert.equal((await reopened.list())[0]?.status, 'paused');
      assert.deepEqual(await reopened.history(rule.id), []);
    } finally { await reopened.close(); }
  } finally { activity.resolve(start); await routines.close(); }
});

test('a manual admission completed during activity lookup makes the automatic occurrence observe cooldown', async t => {
  const dataDir = await directory(t), clock = fakeRoutineClock(start);
  const queried = Promise.withResolvers<void>(), activity = Promise.withResolvers<number>();
  const calls: RoutineOccurrence[] = [];
  const routines = new LocalRoutines({ dataDir, ...clock,
    lastUserActivity: async () => { queried.resolve(); return activity.promise; },
    execute: async occurrence => { calls.push(occurrence); return { taskId: occurrence.taskId }; },
  });
  try {
    await routines.create({ ...rule, workspace: dataDir });
    await until(async () => clock.waitingAt(start + minute), Boolean); clock.advanceTo(start + minute);
    await queried.promise;
    const manual = await routines.runNow(rule.id, 'user-request-during-check');
    await until(() => routines.history(rule.id), rows => rows.some(row => row.id === manual.id && row.status === 'started'));
    activity.resolve(start);
    const skipped = await until(async () => (await routines.history(rule.id)).find(row => !row.trigger), Boolean);
    assert.equal(skipped?.status, 'skipped');
    assert.equal(skipped?.activity?.status, 'cooldown');
    assert.deepEqual(calls.map(row => row.id), [manual.id]);
  } finally { activity.resolve(start); await routines.close(); }
});

test('replaying an admitted task keeps its original start time instead of extending cooldown at recovery', async t => {
  const dataDir = await directory(t), clock = fakeRoutineClock(start);
  const admittedAt = start + minute;
  const routines = new LocalRoutines({ dataDir, ...clock, lastUserActivity: async () => start,
    execute: async occurrence => {
      clock.advanceTo(start + 6 * minute);
      return { taskId: occurrence.taskId, startedAt: admittedAt };
    },
  });
  try {
    await routines.create({ ...rule, workspace: dataDir });
    await until(async () => clock.waitingAt(admittedAt), Boolean); clock.advanceTo(admittedAt);
    const receipt = await until(async () => (await routines.history(rule.id)).find(row => row.status === 'started'), Boolean);
    assert.equal(receipt?.startedAt, admittedAt);
  } finally { await routines.close(); }
});

test('pausing after task admission preserves its cooldown even before the timer saves the receipt', async t => {
  const dataDir = await directory(t), clock = fakeRoutineClock(start);
  const admitted = Promise.withResolvers<void>();
  const calls: string[] = [];
  const routines = new LocalRoutines({ dataDir, ...clock, lastUserActivity: async () => start,
    taskOverview: async () => ({ status: 'completed', reason: null, question: null, summary: 'Done', createdAt: start + minute }),
    execute: async (occurrence, signal) => {
      calls.push(occurrence.id); admitted.resolve();
      if (calls.length === 1) await new Promise<void>((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
      return { taskId: occurrence.taskId };
    },
  });
  try {
    await routines.create({ ...rule, workspace: dataDir });
    await until(async () => clock.waitingAt(start + minute), Boolean); clock.advanceTo(start + minute);
    await admitted.promise;
    await routines.pause(rule.id); await routines.resume(rule.id);
    await until(async () => clock.waitingAt(start + 6 * minute), Boolean); clock.advanceTo(start + 6 * minute);
    const result = await until(async () => (await routines.history(rule.id)).find(row => row.scheduledAt === new Date(start + 6 * minute).toISOString() && row.status !== 'claimed'), Boolean);
    assert.equal(result?.activity?.status, 'cooldown');
    assert.equal(calls.length, 1);
  } finally { await routines.close(); }
});

test('project activity comes from local user requests and persisted Pi follow-ups, never automated task creation', async t => {
  const fixture = await scriptedFixture(() => fauxAssistantMessage(fauxToolCall('task_submit', { summary: 'Checked.', artifacts: [] }), { stopReason: 'toolUse' }));
  let runtime = fixture.runtime;
  t.after(async () => { await runtime.close(); await fixture.close(); });
  const project = join(fixture.directory, 'project'), other = join(fixture.directory, 'other');
  await mkdir(join(project, '.git'), { recursive: true }); await mkdir(join(project, 'src')); await mkdir(other);
  assert.equal(await runtime.lastUserActivity(project), undefined);
  const automatic = await runtime.create('Automatic check', project, [], { routineOccurrenceId: 'rule/1/scheduled' });
  await until(() => runtime.status(automatic.id), row => row.status === 'completed');
  assert.equal(await runtime.lastUserActivity(project), undefined);
  const direct = await runtime.create('User request', join(project, 'src'));
  await until(() => runtime.status(direct.id), row => row.status === 'completed');
  assert.equal(await runtime.lastUserActivity(project), direct.createdAt);
  assert.equal(await runtime.lastUserActivity(other), undefined);
  await runtime.followUp(automatic.id, 'A real user answer', 'user-answer');
  const answered = await until(() => runtime.status(automatic.id), row => row.status === 'completed' && row.goal?.revision === 2);
  const inputAt = answered.goal!.events.find(event => event.type === 'user_input')!.at;
  assert.equal(await runtime.lastUserActivity(project), Math.max(direct.createdAt, inputAt));
  await runtime['active'].get(automatic.id)!.harness.commit(tx => changeGoal(tx, (_goal, record) => {
    for (let index = 0; index < 205; index++) record('checkpoint', 'Internal progress');
  }), BACKGROUND_CONTEXT);
  assert.equal((await runtime.status(automatic.id)).goal?.events.some(event => event.type === 'user_input'), false);
  assert.equal(await runtime.lastUserActivity(project), Math.max(direct.createdAt, inputAt));
  await runtime.close(); runtime = new LocalRuntime(fixture.settings, { models: fixture.models }); await runtime.recover();
  assert.equal(await runtime.lastUserActivity(join(project, 'src')), Math.max(direct.createdAt, inputAt));
});

test('a chat follow-up remains project activity after conversion to a Goal and reopening', async t => {
  let calls = 0;
  const preparing = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const fixture = await scriptedFixture(async () => {
    if (++calls === 1) return fauxAssistantMessage('Ready to help.');
    preparing.resolve(); await release.promise;
    return fauxAssistantMessage(fauxToolCall('task_prepare', {
      outcome: 'Review the project', deliverables: ['Review notes'], inputs: [],
      criteria: [{ text: 'Review complete', method: 'inspect' }],
      scope: ['Current project'], assumptions: [], questions: [],
    }), { stopReason: 'toolUse' });
  });
  let runtime = fixture.runtime;
  t.after(async () => { release.resolve(); await runtime.close(); await fixture.close(); });
  const task = await runtime.create('Hello', fixture.workspace, [], { chat: true });
  await until(() => runtime.status(task.id), status => status.status === 'answered');
  await until(async () => Date.now() > task.createdAt, Boolean);
  await runtime.followUp(task.id, 'Review this project', 'review-request');
  await preparing.promise;
  const repliedAt = await runtime.lastUserActivity(fixture.workspace);
  assert(repliedAt! > task.createdAt);
  release.resolve();
  await until(() => runtime.status(task.id), status => status.status === 'awaiting_confirmation');
  assert.equal(await runtime.lastUserActivity(fixture.workspace), repliedAt);
  await runtime.close(); runtime = new LocalRuntime(fixture.settings, { models: fixture.models });
  await runtime.recover();
  assert.equal(await runtime.lastUserActivity(fixture.workspace), repliedAt);
});

test('the owner API gates scheduled model runs by real project activity and retains cooldown after daemon restart', async t => {
  let modelCalls = 0;
  const fixture = await scriptedFixture(() => {
    modelCalls++;
    return fauxAssistantMessage(fauxToolCall('task_submit', { summary: 'Checked.', artifacts: [] }), { stopReason: 'toolUse' });
  });
  const slot = createServer();
  await new Promise<void>(resolve => slot.listen(0, '127.0.0.1', resolve));
  const port = (slot.address() as { port: number }).port;
  await new Promise<void>(resolve => slot.close(() => resolve()));
  const initial = Date.now(), clock = fakeRoutineClock(initial), settings = { ...fixture.settings, port };
  const options = { models: fixture.models, routineClock: clock }, client = createClient(settings);
  let server = await serve(settings, options);
  t.after(async () => { await server.close(); await fixture.close(); });
  const input = { ...rule, workspace: fixture.workspace,
    schedule: { kind: 'interval', anchorAt: new Date(initial + minute).toISOString(), everyMinutes: 5 } };
  await client.request('/v1/routines', 'POST', input);
  assert.equal((await fetch(`http://127.0.0.1:${port}/v1/routines`, { method: 'POST', body: JSON.stringify(input) })).status, 401);
  const history = () => server.runtime.routines.history(rule.id);
  await until(async () => clock.waitingAt(initial + minute), Boolean); clock.advanceTo(initial + minute);
  await until(history, rows => rows.some(row => row.activity?.status === 'inactive'));
  assert.equal(modelCalls, 0);
  const direct = await client.request<{id: string}>('/v1/tasks', 'POST', { objective: 'Direct user request.', workspace: fixture.workspace, confirmed: true });
  await until(() => server.runtime.status(direct.id), status => status.status === 'completed');
  await until(async () => clock.waitingAt(initial + 6 * minute), Boolean); clock.advanceTo(initial + 6 * minute);
  const rows = await until(history, rows => rows.some(row => row.status === 'started'));
  const admitted = rows.find(row => row.status === 'started')!;
  await until(() => server.runtime.status(admitted.taskId!), status => status.status === 'completed');
  assert.equal(modelCalls, 2);
  await server.close(); server = await serve(settings, options);
  await until(async () => clock.waitingAt(initial + 11 * minute), Boolean); clock.advanceTo(initial + 11 * minute);
  await until(history, rows => rows.some(row => row.activity?.status === 'cooldown'));
  assert.equal(modelCalls, 2);
  assert.equal((await server.runtime.list()).length, 2);
});
