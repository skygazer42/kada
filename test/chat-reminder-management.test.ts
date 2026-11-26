import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { LocalRoutines } from '../src/routines.js';
import { LocalRuntime } from '../src/runtime.js';
import { fakeRoutineClock, hasTool, scriptedFixture, until } from './helpers.js';

const call = (name: string, args: Record<string, unknown>) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' });
const start = Date.parse('2026-12-01T21:00:00Z');
const schedule = { kind: 'weekly' as const, weekday: 2, time: '17:00', timeZone: 'America/New_York' };

test('managed chat creates, updates and cancels a weekly notification without allocating a Goal', async t => {
  const clock = fakeRoutineClock(start);
  let stage: 'create' | 'update' | 'cancel' = 'create', id = '';
  const f = await scriptedFixture(context => {
    assert(hasTool(context, 'reminder_update'));
    const lastUser = context.messages.findLastIndex(message => message.role === 'user');
    const results = context.messages.slice(lastUser + 1).filter(message => message.role === 'toolResult');
    if (!results.length) return call('reminders_info', {});
    if (results.length === 1) {
      if (stage === 'create') return call('reminder_create', { note: 'Check weekly report', schedule });
      if (stage === 'update') return call('reminder_update', { id, revision: 1, note: 'Check revised report', schedule: { ...schedule, time: '18:00' } });
      return call('reminder_cancel', { id, revision: 2 });
    }
    assert(!results.some(message => message.isError), JSON.stringify(results));
    return fauxAssistantMessage('Reminder saved.');
  }, {}, () => [], { routineClock: clock });
  t.after(() => f.close());
  const task = await f.runtime.create('Every Tuesday at 5 PM New York remind me to check the report.', f.workspace, [], { chat: true });
  const first = await until(() => f.runtime.status(task.id), row => row.status === 'answered');
  assert.equal(first.goal, undefined); assert.equal(first.chatReminders, 'managed');
  id = (await f.runtime.routines.list())[0].id;
  assert.deepEqual((await f.runtime.routines.list())[0].schedule, schedule);
  stage = 'update';
  await f.runtime.followUp(task.id, 'Move the reminder to 6 PM and revise its text.', 'update-reminder');
  await until(() => f.runtime.status(task.id), row => row.status === 'answered' && row.submission?.requestId === 'user:update-reminder');
  const edited = (await f.runtime.routines.list())[0];
  assert.equal(edited.revision, 2); assert.equal(edited.objective, 'Check revised report');
  assert.equal(edited.nextRunAt, '2026-12-01T23:00:00.000Z');
  await until(async () => clock.waitingAt(Date.parse(edited.nextRunAt!)), Boolean);
  clock.advanceTo(Date.parse(edited.nextRunAt!));
  await until(() => f.runtime.notifications(), rows => rows.some(row => row.routineId === id));
  assert.equal((await f.runtime.routines.list())[0].nextRunAt, '2026-12-08T23:00:00.000Z');
  stage = 'cancel';
  await f.runtime.followUp(task.id, 'Cancel the weekly reminder.', 'cancel-reminder');
  const done = await until(() => f.runtime.status(task.id), row => row.status === 'answered' && row.submission?.requestId === 'user:cancel-reminder');
  assert.equal(done.goal, undefined);
  assert.equal((await f.runtime.routines.list())[0].status, 'cancelled');
});

test('revision-bound routine update replays its original receipt after later edits and reopening', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'kada-reminder-edit-')), clock = fakeRoutineClock(start);
  let routines = new LocalRoutines({ dataDir, ...clock, execute: async () => ({ status: 'notified' }) });
  t.after(async () => { await routines.close(); await rm(dataDir, { recursive: true, force: true, maxRetries: 5 }); });
  const input = { id: 'weekly', action: 'notify' as const, objective: 'Original', workspace: dataDir, schedule };
  await routines.create(input);
  const request = { expectedRevision: 1, requestId: 'pi-tool-1' };
  const changed = { ...input, objective: 'Revised', schedule: { ...schedule, time: '18:00' } };
  const result = await routines.update(input.id, changed, request);
  assert.equal(result.revision, 2);
  assert.deepEqual(await routines.update(input.id, changed, request), result);
  await assert.rejects(routines.update(input.id, { ...changed, objective: 'Conflicting request' }, request), { status: 409 });
  await routines.update(input.id, { ...input, objective: 'Later revision' });
  await routines.close(); routines = new LocalRoutines({ dataDir, ...clock, execute: async () => ({ status: 'notified' }) });
  await routines.recover();
  assert.deepEqual(await routines.update(input.id, changed, request), result);
  assert.equal((await routines.list())[0].objective, 'Later revision');
  await assert.rejects(routines.update(input.id, changed, { expectedRevision: 1, requestId: 'another-request' }), { status: 409 });
  await routines.cancel(input.id);
  assert.deepEqual(await routines.update(input.id, changed, request), result);
  assert.equal((await routines.list())[0].status, 'cancelled');
});

test('editing a reminder preserves the original project directory and missed-slot policy', async t => {
  const clock = fakeRoutineClock(start);
  const f = await scriptedFixture(context => context.messages.some(message => message.role === 'toolResult') ?
    fauxAssistantMessage('Updated.') : call('reminder_update', { id: 'existing', revision: 1, note: 'Revised daily notice',
      schedule: { kind: 'daily', time: '18:00', timeZone: 'America/New_York' } }), {}, () => [], { routineClock: clock });
  t.after(() => f.close());
  await mkdir(join(f.workspace, '.git')); await mkdir(join(f.workspace, 'src'));
  const original = await f.runtime.routines.create({ id: 'existing', action: 'notify', objective: 'Original', workspace: join(f.workspace, 'src'),
    schedule, missedPolicy: 'skip', budgetPolicy: 'skip', notifyOnChange: true });
  const task = await f.runtime.create('Move my daily reminder to 6 PM.', f.workspace, [], { chat: true });
  const answer = await until(() => f.runtime.status(task.id), row => row.status === 'answered');
  assert(!answer.messages.some(message => message.role === 'toolResult' && message.isError));
  const edited = (await f.runtime.routines.list())[0];
  assert.equal(edited.workspace, original.workspace);
  assert.equal(edited.missedPolicy, 'skip');
  assert.equal(edited.budgetPolicy, 'skip');
  assert.equal(edited.notifyOnChange, true);
  assert.deepEqual(edited.schedule, { kind: 'daily', time: '18:00', timeZone: 'America/New_York' });
});

test('managed reminder validation rejects ambiguous, invalid and non-notification schedules', async t => {
  const invalid = [
    { note: 'No time' },
    { note: 'Two times', at: '2030-01-01T12:00:00Z', schedule },
    { note: 'No zone', schedule: { kind: 'daily', time: '17:00' } },
    { note: 'Bad zone', schedule: { kind: 'daily', time: '17:00', timeZone: 'not-a-zone' } },
    { note: 'Bad clock', schedule: { kind: 'daily', time: '25:00', timeZone: 'UTC' } },
    { note: 'Bad weekday', schedule: { ...schedule, weekday: 7 } },
    { note: 'Event', schedule: { kind: 'event' } },
    { note: 'Extra fields', schedule: { ...schedule, action: 'task' } },
  ];
  let index = 0;
  const f = await scriptedFixture(context => context.messages.some(message => message.role === 'toolResult') ? fauxAssistantMessage('Could not save.') :
    call('reminder_create', invalid[index]!));
  t.after(() => f.close());
  for (; index < invalid.length; index++) {
    const task = await f.runtime.create('Check a requested reminder.', f.workspace, [], { chat: true });
    const answer = await until(() => f.runtime.status(task.id), row => row.status === 'answered');
    assert(answer.messages.some(message => message.role === 'toolResult' && message.isError), JSON.stringify(invalid[index]));
  }
  assert.deepEqual(await f.runtime.routines.list(), []);
});

test('legacy true reminder chats keep single schedules and never gain update tools', async t => {
  let legacy = false;
  const f = await scriptedFixture(context => {
    assert.equal(hasTool(context, 'reminder_update'), !legacy);
    if (!legacy || context.messages.some(message => message.role === 'toolResult')) return fauxAssistantMessage('Checked.');
    return call('reminder_create', { at: '2030-01-01T12:00:00Z', schedule, note: 'Not allowed in the legacy interface' });
  });
  let runtime = f.runtime;
  t.after(async () => { await runtime.close(); await f.close(); });
  const chat = await runtime.create('Hello', f.workspace, [], { chat: true });
  await until(() => runtime.status(chat.id), row => row.status === 'answered');
  const meta = await runtime.metadata(chat.id); meta.chatReminders = true;
  await runtime.close(); await writeFile(join(f.directory, 'tasks', chat.id, 'task.json'), JSON.stringify(meta));
  legacy = true; runtime = new LocalRuntime(f.settings, { models: f.models }); await runtime.recover();
  await runtime.followUp(chat.id, 'Set a reminder.', 'legacy');
  const answer = await until(() => runtime.status(chat.id), row => row.status === 'answered' && row.submission?.requestId === 'user:legacy');
  assert(answer.messages.some(message => message.role === 'toolResult' && message.isError));
  assert.deepEqual(await runtime.routines.list(), []);
});

test('managed info and edits exclude mixed event rules and other projects', async t => {
  let target = 'mixed';
  const f = await scriptedFixture(context => {
    const results = context.messages.filter(message => message.role === 'toolResult');
    if (!results.length) return call('reminders_info', {});
    if (results.length === 1) return call('reminder_update', { id: target, revision: 1, note: 'Must not change', schedule });
    return fauxAssistantMessage('Unavailable.');
  });
  t.after(() => f.close());
  const other = join(f.directory, 'other'); await mkdir(other);
  await f.runtime.routines.create({ id: 'mixed', action: 'notify', objective: 'PRIVATE_EVENT_NOTICE', workspace: f.workspace,
    schedule, event: { source: 'private', type: 'changed', equals: { ok: true } } });
  await f.runtime.routines.create({ id: 'foreign', action: 'notify', objective: 'PRIVATE_OTHER_PROJECT', workspace: other, schedule });
  await f.runtime.routines.create({ id: 'execution', action: 'task', objective: 'PRIVATE_EXECUTION', workspace: f.workspace, schedule });
  for (const name of ['mixed', 'foreign', 'execution']) {
    target = name;
    const task = await f.runtime.create('Edit the reminder.', f.workspace, [], { chat: true });
    const answer = await until(() => f.runtime.status(task.id), row => row.status === 'answered');
    const info = answer.messages.find(message => message.role === 'toolResult' && message.toolName === 'reminders_info');
    assert.doesNotMatch(JSON.stringify(info), /PRIVATE_/);
    assert(answer.messages.some(message => message.role === 'toolResult' && message.toolName === 'reminder_update' && message.isError));
  }
  assert((await f.runtime.routines.list()).every(rule => rule.revision === 1));
});

test('a chat edit keeps a paused reminder paused and rejects a rule changed after lookup', async t => {
  let target = 'paused';
  const clock = fakeRoutineClock(start);
  const f = await scriptedFixture(context => context.messages.some(message => message.role === 'toolResult') ? fauxAssistantMessage('Checked.') :
    call('reminder_update', { id: target, revision: 1, note: 'Revised notice', schedule: { ...schedule, time: '18:00' } }), {}, () => [], { routineClock: clock });
  t.after(() => f.close());
  const input = { action: 'notify' as const, objective: 'Original', workspace: f.workspace, schedule };
  await f.runtime.routines.create({ ...input, id: 'paused' }); await f.runtime.routines.pause('paused');
  const first = await f.runtime.create('Move my paused reminder to 6 PM, keeping it paused.', f.workspace, [], { chat: true });
  const answer = await until(() => f.runtime.status(first.id), row => row.status === 'answered');
  assert(!answer.messages.some(message => message.role === 'toolResult' && message.isError));
  const paused = (await f.runtime.routines.list())[0];
  assert.equal(paused.status, 'paused'); assert.equal(paused.nextRunAt, undefined); assert.equal(paused.revision, 2);
  await assert.rejects(f.runtime.routines.update('paused', { ...input, schedule: { kind: 'once', at: '2026-12-02T22:00:00Z' } }, {
    expectedRevision: 2, requestId: 'paused-to-single',
  }), { status: 409 });
  assert.equal((await f.runtime.routines.resume('paused')).status, 'scheduled');
  await f.runtime.routines.create({ ...input, id: 'changing' }); target = 'changing';
  const update = f.runtime.routines.update.bind(f.runtime.routines);
  t.mock.method(f.runtime.routines, 'update', async (...args: Parameters<typeof update>) => {
    await update('changing', { ...input, action: 'task', objective: 'New execution request' });
    return update(...args);
  });
  const second = await f.runtime.create('Change the reminder.', f.workspace, [], { chat: true });
  const rejected = await until(() => f.runtime.status(second.id), row => row.status === 'answered');
  assert(rejected.messages.some(message => message.role === 'toolResult' && message.toolName === 'reminder_update' && message.isError));
  const changed = (await f.runtime.routines.list()).find(rule => rule.id === 'changing')!;
  assert.equal(changed.action, 'task'); assert.equal(changed.objective, 'New execution request'); assert.equal(changed.revision, 2);
});

test('no-op update receipts cross Pi history pages and competing revisions cannot overwrite each other', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'kada-reminder-receipts-')), clock = fakeRoutineClock(start);
  const routines = new LocalRoutines({ dataDir, ...clock, execute: async () => ({ status: 'notified' }) });
  t.after(async () => { await routines.close(); await rm(dataDir, { recursive: true, force: true, maxRetries: 5 }); });
  const input = { id: 'weekly', action: 'notify' as const, objective: 'Original', workspace: dataDir, schedule };
  const original = await routines.create(input);
  const noChange = { expectedRevision: 1, requestId: 'no-change' };
  assert.deepEqual(await routines.update(input.id, input, noChange), original);
  const competing = await Promise.allSettled([
    routines.update(input.id, { ...input, objective: 'First edit' }, { expectedRevision: 1, requestId: 'first' }),
    routines.update(input.id, { ...input, objective: 'Second edit' }, { expectedRevision: 1, requestId: 'second' }),
  ]);
  assert.equal(competing.filter(result => result.status === 'fulfilled').length, 1);
  const failure = competing.find(result => result.status === 'rejected');
  assert(failure?.status === 'rejected'); assert.equal(failure.reason.status, 409);
  const session = await routines['open']();
  await session.harness.commit(async tx => {
    for (let index = 0; index < 205; index++) await tx.appendEntry(session.conversationId, { kind: 'test.history', data: { index } });
  }, BACKGROUND_CONTEXT);
  await routines.cancel(input.id);
  assert.deepEqual(await routines.update(input.id, input, noChange), original);
  assert.equal((await routines.list())[0].status, 'cancelled');
  for (const request of [{ expectedRevision: 0, requestId: 'invalid' }, { expectedRevision: 1, requestId: '../invalid' }]) {
    await assert.rejects(routines.update(input.id, input, request), { status: 400 });
  }
});
