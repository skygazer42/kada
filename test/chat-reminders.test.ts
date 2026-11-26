import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { LocalRuntime } from '../src/runtime.js';
import { fakeRoutineClock, hasTool, scriptedFixture, until } from './helpers.js';

test('ordinary local chat saves a durable reminder through Pi tools and delivers once without creating a Goal', async t => {
  const now = Date.now(), due = now + 60_000, clock = fakeRoutineClock(now);
  const fixture = await scriptedFixture(context => {
    assert(hasTool(context, 'reminders_info'));
    assert(hasTool(context, 'reminder_create'));
    assert(hasTool(context, 'reminder_cancel'));
    if (!context.messages.some(message => message.role === 'toolResult' && message.toolName === 'reminders_info')) return fauxAssistantMessage(fauxToolCall('reminders_info', {}), { stopReason: 'toolUse' });
    if (!context.messages.some(message => message.role === 'toolResult' && message.toolName === 'reminder_create')) return fauxAssistantMessage(fauxToolCall('reminder_create', { at: new Date(due).toISOString(), note: 'Check the report' }), { stopReason: 'toolUse' });
    return fauxAssistantMessage('Reminder saved.');
  }, {}, () => [], { routineClock: clock });
  let runtime = fixture.runtime;
  t.after(async () => { await runtime.close(); await fixture.close(); });
  const chat = await runtime.create('Remind me to check the report in one minute.', fixture.workspace, [], { chat: true });
  const answered = await until(() => runtime.status(chat.id), status => status.status === 'answered');
  assert.equal(answered.goal, undefined);
  const [reminder] = await runtime.routines.list();
  assert.equal(reminder.action, 'notify'); assert.equal(reminder.objective, 'Check the report');
  assert.deepEqual(reminder.schedule, { kind: 'once', at: new Date(due).toISOString() });
  await runtime.close(); runtime = new LocalRuntime(fixture.settings, { models: fixture.models, routineClock: clock }); await runtime.recover();
  await until(async () => clock.waitingAt(due), Boolean); clock.advanceTo(due);
  await until(() => runtime.notifications(), rows => rows.some(row => row.routineId === reminder.id));
  await runtime.close(); runtime = new LocalRuntime(fixture.settings, { models: fixture.models, routineClock: clock }); await runtime.recover();
  assert.equal((await runtime.notifications()).filter(row => row.routineId === reminder.id).length, 1);
  assert.equal((await runtime.status(chat.id)).goal, undefined);
});

test('chat reminder tools list and cancel only same-project single notifications', async t => {
  let target = '';
  const fixture = await scriptedFixture(context => {
    const results = context.messages.filter(message => message.role === 'toolResult');
    if (!results.some(message => message.toolName === 'reminders_info')) return fauxAssistantMessage(fauxToolCall('reminders_info', {}), { stopReason: 'toolUse' });
    if (!results.some(message => message.toolName === 'reminder_cancel')) return fauxAssistantMessage(fauxToolCall('reminder_cancel', { id: target, revision: 1 }), { stopReason: 'toolUse' });
    return fauxAssistantMessage('Checked the reminder.');
  });
  t.after(() => fixture.close());
  const due = new Date(Date.now() + 3600_000).toISOString(), other = join(fixture.directory, 'other');
  await mkdir(other); await mkdir(join(fixture.workspace, '.git')); await mkdir(join(fixture.workspace, 'src'));
  await fixture.runtime.routines.create({ id: 'mine', action: 'notify', objective: 'Same project', workspace: fixture.workspace, schedule: { kind: 'once', at: due } });
  await fixture.runtime.routines.create({ id: 'foreign', action: 'notify', objective: 'Other project private reminder', workspace: other, schedule: { kind: 'once', at: due } });
  await fixture.runtime.routines.create({ id: 'execution', action: 'task', objective: 'An execution rule', workspace: fixture.workspace, schedule: { kind: 'once', at: due } });
  target = 'foreign';
  const first = await fixture.runtime.create('Cancel the reminder.', join(fixture.workspace, 'src'), [], { chat: true });
  const rejected = await until(() => fixture.runtime.status(first.id), status => status.status === 'answered');
  const list = rejected.messages.find(message => message.role === 'toolResult' && message.toolName === 'reminders_info');
  assert(list); assert.match(JSON.stringify(list), /Same project/);
  assert.doesNotMatch(JSON.stringify(list), /Other project private|An execution rule/);
  assert(rejected.messages.some(message => message.role === 'toolResult' && message.toolName === 'reminder_cancel' && message.isError));
  target = 'mine';
  const second = await fixture.runtime.create('Cancel my reminder.', fixture.workspace, [], { chat: true });
  await until(() => fixture.runtime.status(second.id), status => status.status === 'answered');
  const rules = await fixture.runtime.routines.list();
  assert.equal(rules.find(row => row.id === 'mine')?.status, 'cancelled');
  assert.equal(rules.find(row => row.id === 'foreign')?.status, 'scheduled');
  assert.equal(rules.find(row => row.id === 'execution')?.status, 'scheduled');
});

test('a reminder changed into an execution rule during cancellation cannot be cancelled by the chat tool', async t => {
  const due = new Date(Date.now() + 3600_000).toISOString();
  const fixture = await scriptedFixture(context => context.messages.some(message => message.role === 'toolResult') ?
    fauxAssistantMessage('The reminder changed.') : fauxAssistantMessage(fauxToolCall('reminder_cancel', { id: 'changing', revision: 1 }), { stopReason: 'toolUse' }));
  t.after(() => fixture.close());
  const rule = { id: 'changing', action: 'notify' as const, objective: 'Reminder', workspace: fixture.workspace, schedule: { kind: 'once' as const, at: due } };
  await fixture.runtime.routines.create(rule);
  const cancel = fixture.runtime.routines.cancel.bind(fixture.runtime.routines);
  t.mock.method(fixture.runtime.routines, 'cancel', async (...args: Parameters<typeof cancel>) => {
    await fixture.runtime.routines.update(rule.id, { ...rule, action: 'task' });
    return cancel(...args);
  });
  const chat = await fixture.runtime.create('Cancel my reminder.', fixture.workspace, [], { chat: true });
  const status = await until(() => fixture.runtime.status(chat.id), status => status.status === 'answered');
  assert(status.messages.some(message => message.role === 'toolResult' && message.toolName === 'reminder_cancel' && message.isError));
  assert.equal((await fixture.runtime.routines.list())[0].status, 'scheduled');
});

test('bad reminder times fail visibly and remote, preparation and historical chats do not gain reminder tools', async t => {
  const fixture = await scriptedFixture(context => {
    if (!hasTool(context, 'reminder_create')) return fauxAssistantMessage('No reminder capability.');
    const results = context.messages.filter(message => message.role === 'toolResult');
    if (results.length < 2) return fauxAssistantMessage(fauxToolCall('reminder_create', {
      at: results.length ? '2000-01-01T00:00:00Z' : '2030-01-01T12:00:00', note: 'Invalid time',
    }), { stopReason: 'toolUse' });
    return fauxAssistantMessage('Could not save the reminder.');
  });
  let runtime = fixture.runtime;
  t.after(async () => { await runtime.close(); await fixture.close(); });
  const local = await runtime.create('Set a reminder.', fixture.workspace, [], { chat: true });
  const failed = await until(() => runtime.status(local.id), status => status.status === 'answered');
  assert.equal(failed.goal, undefined);
  assert.equal(failed.messages.filter(message => message.role === 'toolResult' && message.toolName === 'reminder_create' && message.isError).length, 2);
  assert.deepEqual(await runtime.routines.list(), []);
  const remote = await runtime.create('Hello', undefined, [], { chat: true, remote: true });
  const answer = await until(() => runtime.status(remote.id), status => status.status === 'answered');
  assert.equal(answer.chatReminders, undefined);
  assert.equal(answer.messages.filter(message => message.role === 'toolResult').length, 0);
  const metadata = await runtime.metadata(local.id);
  delete metadata.chatReminders;
  await runtime.close();
  await writeFile(join(fixture.directory, 'tasks', local.id, 'task.json'), JSON.stringify(metadata));
  runtime = new LocalRuntime(fixture.settings, { models: fixture.models }); await runtime.recover();
  await runtime.followUp(local.id, 'What can you do?', 'historical');
  const historical = await until(() => runtime.status(local.id), status => status.status === 'answered' && status.messages.at(-1)?.role === 'assistant' && JSON.stringify(status.messages.at(-1)).includes('No reminder capability.'));
  assert.equal(historical.chatReminders, undefined);
  assert.deepEqual(await runtime.routines.list(), []);
});

test('task preparation never exposes chat reminder tools', async () => {
  const fixture = await scriptedFixture(context => {
    for (const name of ['reminders_info', 'reminder_create', 'reminder_cancel']) assert(!hasTool(context, name));
    return fauxAssistantMessage(fauxToolCall('task_prepare', {
      outcome: 'Review the project', deliverables: ['Review notes'], inputs: [],
      criteria: [{ text: 'Review complete', method: 'inspect' }], scope: ['Current project'], assumptions: [], questions: [],
    }), { stopReason: 'toolUse' });
  });
  try {
    const task = await fixture.runtime.create('Prepare project review.', fixture.workspace, [], { prepare: true });
    await until(() => fixture.runtime.status(task.id), status => status.status === 'awaiting_confirmation');
    assert.deepEqual(await fixture.runtime.routines.list(), []);
  } finally { await fixture.close(); }
});
