import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { LocalRuntime } from '../src/runtime.js';
import { hasTool, scriptedFixture, until } from './helpers.js';

test('project task catalog reads current same-project status, prioritizes pending work and pages bounded summaries', async t => {
  const question = '请选择导出格式。' + '问'.repeat(1200);
  const f = await scriptedFixture(context => hasTool(context, 'task_submit')
    ? fauxAssistantMessage(fauxToolCall('task_blocked', { reason: 'Need the user choice.', question }), { stopReason: 'toolUse' })
    : fauxAssistantMessage('Saved.'));
  t.after(() => f.close());
  await mkdir(join(f.workspace, '.git')); await mkdir(join(f.workspace, 'src'));
  const foreignDir = join(f.directory, 'other'); await mkdir(foreignDir);
  const pending = await f.runtime.create('CAT_PENDING ' + '原'.repeat(1000), f.workspace);
  await until(() => f.runtime.status(pending.id), row => row.status === 'waiting_user');
  const delivered = await f.runtime.create('CAT_ANSWERED', f.workspace, [], { chat: true });
  await until(() => f.runtime.status(delivered.id), row => row.status === 'answered');
  const foreign = await f.runtime.create('FOREIGN_PRIVATE', foreignDir, [], { chat: true });
  await until(() => f.runtime.status(foreign.id), row => row.status === 'answered');
  const remote = await f.runtime.create('REMOTE_PRIVATE', f.workspace, [], { chat: true, remote: true });
  await until(() => f.runtime.status(remote.id), row => row.status === 'answered');
  const caller = await f.runtime.create('Query tasks.', join(f.workspace, 'src'), [], { chat: true });
  await until(() => f.runtime.status(caller.id), row => row.status === 'answered');
  const first = await f.runtime.projectTasks(caller.id, 'all', 1, 0);
  assert.equal(first.total, 2); assert.equal(first.nextOffset, 1);
  assert.equal(first.tasks[0].id, pending.id); assert.equal(first.tasks[0].group, 'pending');
  assert.equal(first.tasks[0].question, question.slice(0, 1000));
  assert.equal(first.tasks[0].summary, question.slice(0, 500));
  assert.equal(first.tasks[0].objective.length, 500); assert.equal(first.tasks[0].truncated, true);
  const next = await f.runtime.projectTasks(caller.id, 'all', 1, first.nextOffset!);
  assert.deepEqual(next.tasks.map(row => row.id), [delivered.id]); assert.equal(next.nextOffset, null);
  assert.deepEqual((await f.runtime.projectTasks(caller.id, 'pending')).tasks.map(row => row.id), [pending.id]);
  assert.deepEqual((await f.runtime.projectTasks(caller.id, 'delivered')).tasks.map(row => row.id), [delivered.id]);
  assert.equal((await f.runtime.projectTasks(caller.id, 'running')).total, 0);
  assert.deepEqual((await f.runtime.projectTasks(caller.id, 'all', 20, 30)).tasks, []);
  assert.doesNotMatch(JSON.stringify(first), /PRIVATE|session\.sqlite|modelId|messages|arguments/);
});

test('a local chat calls project_tasks without a Goal and reads the original pending task after restart without resuming it', async t => {
  let query = false, requests = 0;
  const f = await scriptedFixture(context => {
    requests++;
    if (hasTool(context, 'task_submit')) return fauxAssistantMessage(fauxToolCall('task_blocked', { reason: 'Need input.', question: 'CSV 还是 XLSX？' }), { stopReason: 'toolUse' });
    if (!query) return fauxAssistantMessage('Saved.');
    assert(hasTool(context, 'project_tasks'));
    const result = context.messages.find(message => message.role === 'toolResult' && message.toolName === 'project_tasks');
    if (!result) return fauxAssistantMessage(fauxToolCall('project_tasks', { filter: 'pending' }), { stopReason: 'toolUse' });
    assert.equal(result.isError, false);
    return fauxAssistantMessage('原导出任务在等你选择 CSV 或 XLSX。');
  });
  let runtime = f.runtime;
  t.after(async () => { await runtime.close(); await f.close(); });
  const source = await runtime.create('Choose export format.', f.workspace);
  await until(() => runtime.status(source.id), row => row.status === 'waiting_user');
  await runtime.close(); runtime = new LocalRuntime(f.settings, { models: f.models }); await runtime.recover();
  query = true;
  const caller = await runtime.create('这个项目有哪些待处理任务？', f.workspace, [], { chat: true });
  const answer = await until(() => runtime.status(caller.id), row => row.status === 'answered');
  assert.equal(answer.goal, undefined);
  const result = answer.messages.find(message => message.role === 'toolResult' && message.toolName === 'project_tasks')!;
  assert(result && result.role === 'toolResult');
  const value = JSON.parse(result.content.filter(block => block.type === 'text').map(block => block.text).join(''));
  assert.equal(value.tasks[0].id, source.id); assert.equal(value.tasks[0].question, 'CSV 还是 XLSX？');
  await runtime['closeTask'](source.id);
  const before = requests;
  assert.equal((await runtime.projectTasks(caller.id, 'pending')).tasks[0].id, source.id);
  assert.equal(requests, before, 'a status query cannot submit or resume model work');
  assert.equal((await runtime.status(source.id)).status, 'waiting_user');
});

test('remote and historical sessions cannot acquire the task catalog; invalid filters and pages are rejected', async t => {
  const f = await scriptedFixture(context => {
    const last = context.messages.filter(message => message.role === 'user').at(-1)?.content;
    if (last === 'Remote' || last === 'Historical follow-up') assert(!hasTool(context, 'project_tasks'));
    return fauxAssistantMessage('Saved.');
  });
  let runtime = f.runtime;
  t.after(async () => { await runtime.close(); await f.close(); });
  const remote = await runtime.create('Remote', f.workspace, [], { chat: true, remote: true });
  await until(() => runtime.status(remote.id), row => row.status === 'answered');
  await assert.rejects(runtime.projectTasks(remote.id), /unavailable/);
  const old = await runtime.create('Old', f.workspace, [], { chat: true });
  await until(() => runtime.status(old.id), row => row.status === 'answered');
  const meta = await runtime.metadata(old.id); delete meta.projectTaskCatalog;
  await runtime.close(); await writeFile(join(f.directory, 'tasks', old.id, 'task.json'), JSON.stringify(meta));
  runtime = new LocalRuntime(f.settings, { models: f.models }); await runtime.recover();
  await runtime.followUp(old.id, 'Historical follow-up', 'old');
  await until(() => runtime.status(old.id), row => row.status === 'answered' && row.submission?.requestId === 'user:old');
  await assert.rejects(runtime.projectTasks(old.id), /unavailable/);
  const caller = await runtime.create('New', f.workspace, [], { chat: true });
  await until(() => runtime.status(caller.id), row => row.status === 'answered');
  for (const [filter, limit, offset] of [['unknown', 20, 0], ['all', 0, 0], ['all', 51, 0], ['all', 1.5, 0], ['all', 20, -1], ['all', 20, Number.MAX_SAFE_INTEGER + 1]] as const) {
    await assert.rejects(runtime.projectTasks(caller.id, filter, limit, offset), /filter|page/);
  }
});

test('synchronous and background Pi children never inherit project_tasks from the main task', async t => {
  let children = 0;
  const f = await scriptedFixture(context => {
    if (!hasTool(context, 'delegate')) {
      children++; assert(!hasTool(context, 'project_tasks')); return fauxAssistantMessage('Child complete.');
    }
    assert(hasTool(context, 'project_tasks'));
    const background = context.messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes('BACKGROUND'));
    const name = background ? 'delegate_background' : 'delegate';
    if (!context.messages.some(message => message.role === 'toolResult' && message.toolName === name)) return fauxAssistantMessage(fauxToolCall(name, { tasks: [{ name: 'worker', instructions: 'Read independent evidence.' }] }), { stopReason: 'toolUse' });
    if (background && !context.messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes('Background delegation finished.'))) return fauxAssistantMessage('Waiting for the original worker.');
    return fauxAssistantMessage(fauxToolCall('task_submit', { summary: 'Done', artifacts: [] }), { stopReason: 'toolUse' });
  });
  t.after(() => f.close());
  for (const mode of ['SYNC', 'BACKGROUND']) {
    const task = await f.runtime.create(mode, f.workspace);
    await until(() => f.runtime.status(task.id), row => row.status === 'completed');
  }
  assert.equal(children, 2);
});

test('catalog excludes foreign broken sessions before status reads and reports a broken same-project session instead of empty results', async t => {
  const f = await scriptedFixture(() => fauxAssistantMessage('Saved.'));
  let runtime = f.runtime;
  t.after(async () => { await runtime.close(); await f.close(); });
  const foreignDir = join(f.directory, 'foreign'); await mkdir(foreignDir);
  const source = await runtime.create('Original pending work context.', f.workspace, [], { chat: true });
  const foreign = await runtime.create('FOREIGN_PRIVATE', foreignDir, [], { chat: true });
  await until(() => runtime.status(source.id), row => row.status === 'answered');
  await until(() => runtime.status(foreign.id), row => row.status === 'answered');
  await runtime.close();
  await writeFile(join(f.directory, 'tasks', foreign.id, 'session.sqlite'), 'not a SQLite database');
  runtime = new LocalRuntime(f.settings, { models: f.models });
  const caller = await runtime.create('Query', f.workspace, [], { chat: true });
  await until(() => runtime.status(caller.id), row => row.status === 'answered');
  assert.equal((await runtime.projectTasks(caller.id)).tasks[0].id, source.id);
  assert(!runtime['active'].has(foreign.id));
  await runtime.close();
  await writeFile(join(f.directory, 'tasks', source.id, 'session.sqlite'), 'not a SQLite database');
  runtime = new LocalRuntime(f.settings, { models: f.models });
  await assert.rejects(runtime.projectTasks(caller.id), /database|SQLite/i);
});

test('Pi rejects extra catalog parameters and keeps the same tool when a chat becomes a confirmed Goal', async t => {
  const f = await scriptedFixture(context => {
    assert(hasTool(context, 'project_tasks'));
    const reads = context.messages.filter(message => message.role === 'toolResult' && message.toolName === 'project_tasks');
    if (hasTool(context, 'task_prepare')) {
      if (!reads.length) return fauxAssistantMessage(fauxToolCall('project_tasks', { workspace: 'another-project' }), { stopReason: 'toolUse' });
      if (reads.length === 1) {
        assert.equal(reads[0].isError, true);
        return fauxAssistantMessage(fauxToolCall('project_tasks', {}), { stopReason: 'toolUse' });
      }
      assert.equal(reads[1].isError, false);
      return fauxAssistantMessage(fauxToolCall('task_prepare', { outcome: 'Review project tasks', deliverables: ['A short text report'], inputs: [],
        criteria: [{ text: 'Current tasks reviewed', method: 'inspect' }], scope: ['Read current project tasks only'], assumptions: [], questions: [] }), { stopReason: 'toolUse' });
    }
    if (reads.length < 3) return fauxAssistantMessage(fauxToolCall('project_tasks', { filter: 'pending' }), { stopReason: 'toolUse' });
    return fauxAssistantMessage(fauxToolCall('task_submit', { summary: 'The project has no other pending tasks.', artifacts: [],
      criteria: [{ id: 1, status: 'passed', evidence: 'Read the current project catalog.' }] }), { stopReason: 'toolUse' });
  });
  t.after(() => f.close());
  const task = await f.runtime.create('Review project tasks.', f.workspace, [], { chat: true });
  const brief = await until(() => f.runtime.status(task.id), row => row.status === 'awaiting_confirmation');
  await f.runtime.confirm(task.id, brief.goal!.brief!.revision, brief.briefDigest!);
  const done = await until(() => f.runtime.status(task.id), row => row.status === 'completed');
  assert.equal(done.messages.filter(message => message.role === 'toolResult' && message.toolName === 'project_tasks').length, 3);
  assert.equal(done.projectTaskCatalog, true);
});
