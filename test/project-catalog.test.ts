import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { LocalRuntime } from '../src/runtime.js';
import { hasTool, scriptedFixture, until } from './helpers.js';

test('local chat reads a bounded portfolio from the original stores without creating work', async t => {
  let requests = 0;
  const f = await scriptedFixture(context => {
    requests++;
    const user = context.messages.findLast(message => message.role === 'user');
    const input = String(user?.content);
    if (input === 'Remote private') {
      assert(!hasTool(context, 'project_catalog'));
    }
    if (input === 'Read the project catalog' && !context.messages.some(message => message.role === 'toolResult')) {
      assert(hasTool(context, 'project_catalog'));
      return fauxAssistantMessage(fauxToolCall('project_catalog', { limit: 1 }), { stopReason: 'toolUse' });
    }
    return fauxAssistantMessage('Read complete.');
  });
  t.after(() => f.close());
  const local = f.workspace, foreign = join(f.directory, 'other-project');
  const skill = join(local, '.agents', 'skills', 'local-fixture');
  await mkdir(join(local, '.git'));
  await mkdir(foreign);
  await mkdir(skill, { recursive: true });
  await writeFile(join(skill, 'SKILL.md'), '---\nname: local-fixture\ndescription: Read the sample\n---\n\nPrivate source detail.');
  const original = await f.runtime.create('Original local run', local, [], { chat: true });
  const remote = await f.runtime.create('Remote private', local, [], { chat: true, remote: true });
  for (const task of [original, remote]) await until(() => f.runtime.status(task.id), status => status.status === 'answered');
  const first = await f.runtime.workItems.create({ workspace: local, title: 'Local todo', objective: 'Inspect sample.' });
  const second = await f.runtime.workItems.create({ workspace: local, title: 'Second todo', objective: 'Read sample.' });
  const archived = await f.runtime.workItems.create({ workspace: local, title: 'Archived private', objective: 'Archive this.' });
  await f.runtime.workItems.update(archived.id, { revision: archived.revision, archived: true });
  await f.runtime.workItems.create({ workspace: foreign, title: 'Foreign private', objective: 'Different project.' });
  const schedule = { kind: 'once' as const, at: new Date(Date.now() + 86_400_000).toISOString() };
  const rule = await f.runtime.routines.create({ id: 'own-rule', workspace: local, action: 'task', objective: 'Local rule', schedule,
    precheck: { command: [process.execPath, 'PRIVATE_ARGUMENT'] } });
  await f.runtime.routines.create({ id: 'foreign-rule', workspace: foreign, action: 'notify', objective: 'Foreign private', schedule });
  await f.runtime.routines.create({ id: 'unscoped-rule', action: 'notify', objective: 'Unscoped private', schedule });
  const caller = await f.runtime.create('Read the project catalog', local, [], { chat: true });
  const response = await until(() => f.runtime.status(caller.id), status => ['answered', 'failed'].includes(status.status));
  assert.equal(response.status, 'answered', JSON.stringify(response.submission));
  assert.equal(response.goal, undefined);
  const result = response.messages.find(message => message.role === 'toolResult' && message.toolName === 'project_catalog');
  assert(result?.role === 'toolResult' && !result.isError);
  const value = JSON.parse(result.content.map(part => part.type === 'text' ? part.text : '').join(''));
  assert.deepEqual(value.runs.items.map((item: { id: string }) => item.id), [original.id]);
  assert.equal(value.work_items.total, 2);
  assert.equal(value.work_items.items.length, 1);
  assert.equal(value.work_items.nextOffset, 1);
  assert.deepEqual(value.routines.items.map((item: { id: string }) => item.id), [rule.id]);
  assert.equal(value.skills.items[0].name, 'local-fixture');
  assert.doesNotMatch(JSON.stringify(value), /\bprivate\b|PRIVATE_ARGUMENT|session\.sqlite/i);
  const before = requests;
  const page = await f.runtime.projectCatalog(caller.id, 'work_items', 1, 1);
  assert.deepEqual([value.work_items.items[0].id, page.work_items!.items[0]!.id].sort(), [first.id, second.id].sort());
  assert.equal(page.work_items?.nextOffset, null);
  assert.equal(requests, before);
  await assert.rejects(f.runtime.projectCatalog(remote.id), /unavailable/);
});

test('the catalog stays unavailable to old chats and leaves the tool set at preparation and confirmation', async t => {
  const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' });
  let oldFollowUp = false;
  const f = await scriptedFixture(context => {
    const latest = context.messages.findLast(message => message.role === 'user');
    if (latest?.content === 'Reopen an old chat') {
      assert(!hasTool(context, 'project_catalog'));
      oldFollowUp = true;
      return fauxAssistantMessage('Old chat answered.');
    }
    if (hasTool(context, 'task_submit')) {
      assert(!hasTool(context, 'project_catalog'));
      return call('task_submit', { summary: 'Sample answered.', artifacts: [], criteria: [{ id: 1, status: 'passed', evidence: 'Text supplied.' }] });
    }
    if (latest?.content === 'Prepare to answer the sample.' || latest?.content === 'Direct preparation.') {
      assert.equal(hasTool(context, 'project_catalog'), latest.content === 'Prepare to answer the sample.');
      return call('task_prepare', { outcome: 'Reply to a sample', deliverables: ['Text answer'], inputs: [],
        criteria: [{ text: 'Answer the sample', method: 'inspect' }], scope: ['Only the sample'], assumptions: [], questions: [] });
    }
    assert(hasTool(context, 'project_catalog'));
    return fauxAssistantMessage('Original chat answered.');
  });
  let runtime = f.runtime;
  t.after(async () => { await runtime.close(); await f.close(); });
  const old = await runtime.create('Original chat.', f.workspace, [], { chat: true });
  await until(() => runtime.status(old.id), state => state.status === 'answered');
  const saved = await runtime.metadata(old.id);
  delete saved.projectCatalog;
  await runtime.close();
  await writeFile(join(f.directory, 'tasks', old.id, 'task.json'), JSON.stringify(saved));
  runtime = new LocalRuntime(f.settings, { models: f.models });
  await runtime.recover();
  await runtime.followUp(old.id, 'Reopen an old chat', 'old-catalog');
  await until(() => runtime.status(old.id), state => state.status === 'answered' && state.submission?.requestId === 'user:old-catalog');
  assert(oldFollowUp);
  await assert.rejects(runtime.projectCatalog(old.id), /unavailable/);
  const preparing = await runtime.create('Direct preparation.', f.workspace, [], { prepare: true });
  await until(() => runtime.status(preparing.id), state => state.status === 'awaiting_confirmation');
  const task = await runtime.create('Prepare to answer the sample.', f.workspace, [], { chat: true });
  const waiting = await until(() => runtime.status(task.id), state => state.status === 'awaiting_confirmation');
  await runtime.confirm(task.id, waiting.goal!.brief!.revision, waiting.briefDigest!);
  await until(() => runtime.status(task.id), state => state.status === 'completed');
});
