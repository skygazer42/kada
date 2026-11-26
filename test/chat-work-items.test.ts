import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxToolCall, type ToolResultMessage } from '@earendil-works/pi-ai';
import { LocalRuntime } from '../src/runtime.js';
import { hasTool, scriptedFixture, until } from './helpers.js';

const call = (name: string, args: Record<string, unknown>) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' });
const value = (result: ToolResultMessage) => JSON.parse(result.content.filter(block => block.type === 'text').map(block => block.text).join(''));

test('ordinary chat saves, reads, edits, completes and archives one work item without a Goal or execution', async t => {
  const f = await scriptedFixture(context => {
    assert(hasTool(context, 'work_item_create'));
    const results = context.messages.filter((message): message is ToolResultMessage => message.role === 'toolResult');
    const create = results.find(result => result.toolName === 'work_item_create');
    if (!create) return call('work_item_create', { title: 'Weekly report', objective: 'Prepare next report' });
    assert.equal(create.isError, false); const item = value(create);
    if (!results.some(result => result.toolName === 'work_item_read')) return call('work_item_read', { id: item.id });
    const edits = results.filter(result => result.toolName === 'work_item_update');
    assert(edits.every(result => !result.isError));
    if (!edits.length) return call('work_item_update', { id: item.id, revision: 1, title: 'Monthly report', status: 'parked' });
    if (edits.length === 1) return call('work_item_update', { id: item.id, revision: 2, status: 'done' });
    if (edits.length === 2) return call('work_item_update', { id: item.id, revision: 3, archived: true });
    if (!results.some(result => result.toolName === 'work_items_list')) return call('work_items_list', { includeDone: true, includeArchived: true });
    return fauxAssistantMessage('The saved item is completed and archived.');
  });
  t.after(() => f.close());
  const chat = await f.runtime.create('Manage my saved report todo.', f.workspace, [], { chat: true });
  const answer = await until(() => f.runtime.status(chat.id), row => ['answered', 'failed'].includes(row.status));
  assert.equal(answer.status, 'answered'); assert.equal(answer.goal, undefined);
  const [item] = await f.runtime.workItems.list(f.workspace);
  assert.equal(item.title, 'Monthly report'); assert.equal(item.status, 'done'); assert.equal(item.archived, true); assert.equal(item.revision, 4);
  assert.equal((await f.runtime.workItems.runs(item.id)).length, 0);
  assert.equal((await f.runtime.list()).length, 1);
  const list = answer.messages.find((message): message is ToolResultMessage => message.role === 'toolResult' && message.toolName === 'work_items_list')!;
  assert.equal(value(list).items[0].id, item.id);
  assert.doesNotMatch(JSON.stringify(value(list)), /operations|fingerprint|requestId/);
});

test('chat work item tools enforce project ownership and strict inputs before changing anything', async t => {
  let target = '', step = 0;
  const f = await scriptedFixture(context => {
    assert(hasTool(context, 'work_item_update'));
    const results = context.messages.filter((message): message is ToolResultMessage => message.role === 'toolResult');
    if (results.length) assert.equal(results.at(-1)!.isError, true);
    const operations = [
      () => call('work_item_update', { id: target, revision: 1, status: 'done' }),
      () => call('work_item_read', { id: target }),
      () => call('work_item_create', { title: 'Injected', objective: 'Injected', workspace: 'elsewhere' }),
      () => call('work_items_list', { limit: 51 }),
      () => call('work_items_list', { offset: -1 }),
    ];
    return step < operations.length ? operations[step++]!() : fauxAssistantMessage('Requests rejected.');
  });
  t.after(() => f.close());
  const other = join(f.directory, 'foreign'); await mkdir(other);
  const foreign = await f.runtime.workItems.create({ workspace: other, title: 'FOREIGN_PRIVATE', objective: 'PRIVATE' }); target = foreign.id;
  const chat = await f.runtime.create('Check rejected changes.', f.workspace, [], { chat: true });
  const answer = await until(() => f.runtime.status(chat.id), row => ['answered', 'failed'].includes(row.status));
  assert.equal(answer.status, 'answered'); assert.equal(step, 5);
  assert.deepEqual(await f.runtime.workItems.get(foreign.id), foreign);
  assert.deepEqual(await f.runtime.workItems.list(f.workspace), []);
  const results = answer.messages.filter((message): message is ToolResultMessage => message.role === 'toolResult');
  assert.doesNotMatch(JSON.stringify(results), /FOREIGN_PRIVATE/);
});

test('chat work item lists hide done and archived by default, page original identities and bound read text', async t => {
  let step = 0, original = '';
  const f = await scriptedFixture(context => {
    assert(hasTool(context, 'work_items_list'));
    const operations = [
      () => call('work_items_list', { limit: 1 }),
      () => call('work_items_list', { limit: 1, offset: 1 }),
      () => call('work_items_list', { includeDone: true, includeArchived: true }),
      () => call('work_item_read', { id: original }),
    ];
    return step < operations.length ? operations[step++]!() : fauxAssistantMessage('Read saved work.');
  });
  t.after(() => f.close());
  await mkdir(join(f.workspace, '.git')); const sub = join(f.workspace, 'src'); await mkdir(sub);
  for (const [title, state, archive] of [['Open', 'open', false], ['Parked', 'parked', false], ['Done', 'done', false], ['Archived', 'open', true]] as const) {
    const item = await f.runtime.workItems.create({ workspace: f.workspace, title, objective: '长'.repeat(9000), status: state });
    if (title === 'Open') original = item.id;
    if (archive) await f.runtime.workItems.update(item.id, { revision: 1, archived: true });
  }
  const chat = await f.runtime.create('List saved work.', sub, [], { chat: true });
  const answer = await until(() => f.runtime.status(chat.id), row => ['answered', 'failed'].includes(row.status));
  assert.equal(answer.status, 'answered');
  const results = answer.messages.filter((message): message is ToolResultMessage => message.role === 'toolResult').map(value);
  assert.equal(results[0].total, 2); assert.equal(results[0].nextOffset, 1); assert.equal(results[1].nextOffset, null);
  assert.notEqual(results[0].items[0].id, results[1].items[0].id);
  assert.equal(results[0].items[0].objective.length, 500); assert.equal(results[0].items[0].truncated, true);
  assert.equal(results[2].total, 4);
  assert.equal(results[3].objective.length, 8000); assert.equal(results[3].truncated, true);
});

test('historical, remote, preparation and execution tasks do not acquire chat work item tools', async t => {
  const f = await scriptedFixture(context => {
    const last = context.messages.filter(message => message.role === 'user').at(-1)?.content;
    if (last !== 'New chat') assert(!hasTool(context, 'work_items_list'));
    if (hasTool(context, 'task_submit')) return call('task_submit', { summary: 'Done', artifacts: [] });
    if (last === 'Prepare') return call('task_prepare', { outcome: 'Review', deliverables: ['Notes'], inputs: [],
      criteria: [{ text: 'Reviewed', method: 'inspect' }], scope: ['Project'], assumptions: [], questions: [] });
    return fauxAssistantMessage('Saved.');
  });
  let runtime = f.runtime;
  t.after(async () => { await runtime.close(); await f.close(); });
  const old = await runtime.create('New chat', f.workspace, [], { chat: true });
  await until(() => runtime.status(old.id), row => row.status === 'answered');
  const meta = await runtime.metadata(old.id); delete meta.chatWorkItems;
  await runtime.close(); await writeFile(join(f.directory, 'tasks', old.id, 'task.json'), JSON.stringify(meta));
  runtime = new LocalRuntime(f.settings, { models: f.models }); await runtime.recover();
  await runtime.followUp(old.id, 'Historical', 'old');
  await until(() => runtime.status(old.id), row => row.status === 'answered' && row.submission?.requestId === 'user:old');
  const remote = await runtime.create('Remote', f.workspace, [], { chat: true, remote: true });
  await until(() => runtime.status(remote.id), row => row.status === 'answered');
  const prep = await runtime.create('Prepare', f.workspace, [], { prepare: true });
  await until(() => runtime.status(prep.id), row => row.status === 'awaiting_confirmation');
  const task = await runtime.create('Execute', f.workspace);
  await until(() => runtime.status(task.id), row => row.status === 'completed');
});

test('turning a chat into a confirmed Goal removes todo mutation tools from the main task and its Pi child', async t => {
  let childCalls = 0;
  const f = await scriptedFixture(context => {
    if (hasTool(context, 'task_prepare')) {
      assert(hasTool(context, 'work_item_create'));
      return call('task_prepare', { outcome: 'Inspect project', deliverables: ['A short report'], inputs: [],
        criteria: [{ text: 'Independent evidence inspected', method: 'inspect' }], scope: ['Read project'], assumptions: [], questions: [] });
    }
    for (const name of ['work_item_create', 'work_item_update', 'work_item_read', 'work_items_list']) assert(!hasTool(context, name));
    if (!hasTool(context, 'delegate')) { childCalls++; return fauxAssistantMessage('Evidence inspected.'); }
    if (!context.messages.some(message => message.role === 'toolResult' && message.toolName === 'delegate')) return call('delegate', { tasks: [{ name: 'reader', instructions: 'Read independent evidence.' }] });
    return call('task_submit', { summary: 'Evidence inspected.', artifacts: [], criteria: [{ id: 1, status: 'passed', evidence: 'Read the child result.' }] });
  });
  t.after(() => f.close());
  const task = await f.runtime.create('Inspect the project.', f.workspace, [], { chat: true });
  const brief = await until(() => f.runtime.status(task.id), row => row.status === 'awaiting_confirmation');
  await f.runtime.confirm(task.id, brief.goal!.brief!.revision, brief.briefDigest!);
  await until(() => f.runtime.status(task.id), row => row.status === 'completed');
  assert.equal(childCalls, 1); assert.deepEqual(await f.runtime.workItems.list(f.workspace), []);
});
