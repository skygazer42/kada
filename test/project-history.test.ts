import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { UserEntry, AssistantEntry, Harness, createRegistry } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { LocalRuntime } from '../src/runtime.js';
import { hasTool, scriptedFixture, until } from './helpers.js';

test('project history finds original user and assistant text, excludes other projects and internal inputs, and reads by identity', async t => {
  const f = await scriptedFixture(() => fauxAssistantMessage('原始答复：预算是 120 元，编号 HISTORY_42。'));
  t.after(() => f.close());
  const other = join(f.directory, 'other');
  await mkdir(join(f.workspace, '.git')); await mkdir(join(f.workspace, 'src')); await mkdir(other);
  const source = await f.runtime.create('之前决定：HISTORY_42 项目预算 120 元。', f.workspace, [], { chat: true });
  await until(() => f.runtime.status(source.id), row => row.status === 'answered');
  const foreign = await f.runtime.create('HISTORY_42 OTHER_PRIVATE', other, [], { chat: true });
  await until(() => f.runtime.status(foreign.id), row => row.status === 'answered');
  const remote = await f.runtime.create('HISTORY_42 REMOTE_PRIVATE', f.workspace, [], { chat: true, remote: true });
  await until(() => f.runtime.status(remote.id), row => row.status === 'answered');
  const active = f.runtime['active'].get(source.id)!;
  await active.root.submit({ type: 'input', requestId: 'supervisor:1', content: 'HISTORY_42 INTERNAL_SUPERVISOR' }, BACKGROUND_CONTEXT);
  await until(() => f.runtime.status(source.id), row => row.status === 'answered' && row.submission?.requestId === 'supervisor:1');
  await active.harness.commit(async tx => {
    await tx.appendEntry(active.root.id, { kind: 'pi.compaction', model: [{ role: 'user', content: 'HISTORY_42 INTERNAL_SUMMARY', timestamp: Date.now() }] });
  }, BACKGROUND_CONTEXT);
  const caller = await f.runtime.create('找之前预算', join(f.workspace, 'src'), [], { chat: true });
  await until(() => f.runtime.status(caller.id), row => row.status === 'answered');
  const hits = await f.runtime.searchHistory(caller.id, 'HISTORY_42 预算');
  assert(hits.length >= 2);
  assert(hits.every(hit => hit.taskId === source.id));
  assert.doesNotMatch(JSON.stringify(hits), /PRIVATE|INTERNAL/);
  assert.deepEqual(await f.runtime.searchHistory(caller.id, 'INTERNAL'), []);
  const automatic = await f.runtime.create('HISTORY_AUTO automatic rule input', f.workspace, [], { chat: true, routineOccurrenceId: 'rule/1/scheduled' });
  await until(() => f.runtime.status(automatic.id), row => row.status === 'answered');
  assert.deepEqual(await f.runtime.searchHistory(caller.id, 'HISTORY_AUTO'), []);
  await f.runtime.followUp(automatic.id, 'HISTORY_AUTO human follow-up', 'human');
  await until(() => f.runtime.status(automatic.id), row => row.status === 'answered' && row.submission?.requestId === 'user:human');
  const [human] = await f.runtime.searchHistory(caller.id, 'HISTORY_AUTO');
  assert.equal(human.taskId, automatic.id);
  assert.equal((await f.runtime.readHistory(caller.id, human.taskId, human.entryId)).text, 'HISTORY_AUTO human follow-up');
  const user = hits.find(hit => hit.role === 'user')!;
  assert.equal((await f.runtime.readHistory(caller.id, user.taskId, user.entryId)).text, '之前决定：HISTORY_42 项目预算 120 元。');
  await assert.rejects(f.runtime.readHistory(caller.id, foreign.id, user.entryId), /History message not found/);
  await assert.rejects(f.runtime.readHistory(caller.id, remote.id, user.entryId), /History message not found/);
  await assert.rejects(f.runtime.readHistory(caller.id, source.id, 1), /History message not found/);
  const unrelated = join(f.settings.dataDir, 'tasks', 'c56cc3b2-d780-468f-8e5d-d1fb31ae0384');
  await mkdir(unrelated);
  await writeFile(join(unrelated, 'task.json'), '{');
  assert.equal((await f.runtime.readHistory(caller.id, user.taskId, user.entryId)).text, '之前决定：HISTORY_42 项目预算 120 元。');
});

test('a new local assistant uses history search and read without a Goal and keeps source identity after native reset and reopen', async t => {
  let recalling = false;
  const f = await scriptedFixture(context => {
    if (!recalling) return fauxAssistantMessage('Saved decision: use SQLite.');
    assert(hasTool(context, 'history_search')); assert(hasTool(context, 'history_read'));
    const results = context.messages.filter(message => message.role === 'toolResult');
    const search = results.find(message => message.toolName === 'history_search');
    if (!search) return fauxAssistantMessage(fauxToolCall('history_search', { query: 'HISTORY_SQLITE' }), { stopReason: 'toolUse' });
    const found = JSON.parse(search.content.filter(block => block.type === 'text').map(block => block.text).join('')).hits[0];
    if (!results.some(message => message.toolName === 'history_read')) return fauxAssistantMessage(fauxToolCall('history_read', { taskId: found.taskId, entryId: found.entryId }), { stopReason: 'toolUse' });
    return fauxAssistantMessage('原讨论选择 SQLite，来源已查阅。');
  });
  let runtime = f.runtime;
  t.after(async () => { await runtime.close(); await f.close(); });
  const source = await runtime.create('HISTORY_SQLITE: use SQLite for this project.', f.workspace, [], { chat: true });
  await until(() => runtime.status(source.id), row => row.status === 'answered');
  const active = runtime['active'].get(source.id)!;
  await active.root.reset('Only the new context.', BACKGROUND_CONTEXT);
  await until(() => runtime.status(source.id), row => row.tasks.length === 0);
  await runtime.close(); runtime = new LocalRuntime(f.settings, { models: f.models }); await runtime.recover();
  recalling = true;
  const caller = await runtime.create('之前的数据库选择是什么？', f.workspace, [], { chat: true });
  const answer = await until(() => runtime.status(caller.id), row => row.status === 'answered');
  assert.equal(answer.goal, undefined);
  assert(answer.messages.some(message => message.role === 'toolResult' && message.toolName === 'history_read' && !message.isError));
  const [hit] = await runtime.searchHistory(caller.id, 'HISTORY_SQLITE');
  assert.equal(hit.taskId, source.id);
  assert.equal((await runtime.readHistory(caller.id, hit.taskId, hit.entryId)).text, 'HISTORY_SQLITE: use SQLite for this project.');
});

test('history scans native submission pages, keeps literal Unicode snippets and bounds original reads', async t => {
  const f = await scriptedFixture(() => fauxAssistantMessage('Saved.'));
  t.after(() => f.close());
  const source = await f.runtime.create('First historical message.', f.workspace, [], { chat: true });
  await until(() => f.runtime.status(source.id), row => row.status === 'answered');
  const active = f.runtime['active'].get(source.id)!;
  const long = 'İ'.repeat(500) + '预算 HISTORY_LONG %_' + '尾'.repeat(8500);
  const original = await active.harness.commit(async tx => {
    let oldest = 0;
    for (let index = 0; index < 215; index++) {
      const entry = await tx.appendEntry(active.root.id, { kind: UserEntry.kind, model: [{ role: 'user', content: index ? 'Paged HISTORY_PAGE ' + index : long, timestamp: Date.now() + index }] });
      const answer = await tx.appendEntry(active.root.id, { kind: AssistantEntry.kind, model: [fauxAssistantMessage('Recorded.')] });
      await tx.createSubmission({ type: 'input', conversationId: active.root.id, requestId: 'user:page-' + index, status: 'done', entry: entry.id, answer: answer.id });
      if (!index) oldest = entry.id;
    }
    return oldest;
  }, BACKGROUND_CONTEXT);
  const caller = await f.runtime.create('Read earlier history.', f.workspace, [], { chat: true });
  await until(() => f.runtime.status(caller.id), row => row.status === 'answered');
  const [hit] = await f.runtime.searchHistory(caller.id, '预算 history_long %_');
  assert.equal(hit.entryId, original);
  assert.equal(hit.taskId, source.id);
  assert.equal(hit.snippet.length, 400);
  assert.match(hit.snippet, /预算 HISTORY_LONG %_/);
  assert.equal(hit.truncated, true);
  const full = await f.runtime.readHistory(caller.id, source.id, hit.entryId);
  assert.equal(full.text, long.slice(0, 8000));
  assert.equal(full.truncated, true);
  assert.equal((await f.runtime.searchHistory(caller.id, 'history_page', 20)).length, 20);
  for (const [query, limit] of [['', 8], ['x'.repeat(201), 8], ['a b c d e f g h i j k l m', 8], ['history', 0], ['history', 21]] as const) {
    await assert.rejects(f.runtime.searchHistory(caller.id, query, limit));
  }
});

test('actual Pi compaction and reopen preserve searchable original messages without returning the summary', async t => {
  const f = await scriptedFixture(context => context.messages.some(message => message.role === 'system' && JSON.stringify(message).includes('context summarization assistant')) ?
    fauxAssistantMessage('INTERNAL_COMPACTION_SUMMARY') : fauxAssistantMessage('The original decision was saved.'));
  let runtime = f.runtime;
  t.after(async () => { await runtime.close(); await f.close(); });
  const source = await runtime.create('HISTORY_COMPACT 原始决定：使用 SQLite。', f.workspace, [], { chat: true });
  await until(() => runtime.status(source.id), row => row.status === 'answered');
  const caller = await runtime.create('Find the original decision.', f.workspace, [], { chat: true });
  await until(() => runtime.status(caller.id), row => row.status === 'answered');
  const before = await runtime.searchHistory(caller.id, 'HISTORY_COMPACT');
  await runtime.close();
  const harness = await Harness.open(await openNodeSqliteStorage(join(f.directory, 'tasks', source.id, 'session.sqlite')),
    { models: f.models, registry: createRegistry(), settings: { compaction: { enabled: true, keepRecentTokens: 256, backgroundTokens: 0 } } }, BACKGROUND_CONTEXT);
  try {
    const root = await harness.root(BACKGROUND_CONTEXT);
    for (let chunk = 0; chunk < 2; chunk++) {
      const write = await root.submit({ type: 'write', entry: { kind: UserEntry.kind, model: [{ role: 'user', content: 'Archived reference material. '.repeat(3000), timestamp: Date.now() }] } }, BACKGROUND_CONTEXT);
      assert.equal((await write.wait(BACKGROUND_CONTEXT)).status, 'done');
    }
    const compaction = await root.compact('Keep the original decision.', BACKGROUND_CONTEXT);
    const outcome = (await harness.waitForTask(compaction, BACKGROUND_CONTEXT)).state.outcome;
    assert.equal(outcome.status, 'completed');
    if (outcome.status === 'completed' && outcome.result.submissionId !== undefined) await (await harness.submission(outcome.result.submissionId, BACKGROUND_CONTEXT))!.wait(BACKGROUND_CONTEXT);
    assert((await root.context(BACKGROUND_CONTEXT)).entries.some(entry => entry.kind === 'pi.compaction'));
  } finally { await harness.close(BACKGROUND_CONTEXT); }
  runtime = new LocalRuntime(f.settings, { models: f.models }); await runtime.recover();
  await runtime['closeTask'](source.id);
  assert.equal(runtime['active'].has(source.id), false);
  assert.deepEqual(await runtime.searchHistory(caller.id, 'HISTORY_COMPACT'), before);
  assert.deepEqual(await runtime.searchHistory(caller.id, 'INTERNAL_COMPACTION_SUMMARY'), []);
  assert.equal((await runtime.readHistory(caller.id, source.id, before[0].entryId)).text, 'HISTORY_COMPACT 原始决定：使用 SQLite。');
  assert.equal(runtime['active'].has(source.id), false, 'recall must not open an old task runtime just to read its stored messages');
});

test('remote and historical tasks cannot gain project history while local preparation can read it', async t => {
  const f = await scriptedFixture(context => {
    const last = context.messages.filter(message => message.role === 'user').at(-1)?.content;
    if (last === 'Prepare a local review') {
      assert(hasTool(context, 'history_search')); assert(hasTool(context, 'history_read'));
      return fauxAssistantMessage(fauxToolCall('task_prepare', { outcome: 'Local review', deliverables: ['Review notes'], inputs: [],
        criteria: [{ text: 'Prior decisions checked', method: 'inspect' }], scope: ['Current project'], assumptions: [], questions: [] }), { stopReason: 'toolUse' });
    }
    if (last === 'Private remote' || last === 'Historical follow-up') {
      assert(!hasTool(context, 'history_search')); assert(!hasTool(context, 'history_read'));
    }
    return fauxAssistantMessage('Saved.');
  });
  let runtime = f.runtime;
  t.after(async () => { await runtime.close(); await f.close(); });
  const remote = await runtime.create('Private remote', undefined, [], { chat: true, remote: true });
  await until(() => runtime.status(remote.id), row => row.status === 'answered');
  await assert.rejects(runtime.searchHistory(remote.id, 'private'), /unavailable/);
  const prep = await runtime.create('Prepare a local review', f.workspace, [], { prepare: true });
  await until(() => runtime.status(prep.id), row => row.status === 'awaiting_confirmation');
  const old = await runtime.create('Old chat', f.workspace, [], { chat: true });
  await until(() => runtime.status(old.id), row => row.status === 'answered');
  const meta = await runtime.metadata(old.id); delete meta.historyRecall;
  await runtime.close();
  await writeFile(join(f.directory, 'tasks', old.id, 'task.json'), JSON.stringify(meta));
  runtime = new LocalRuntime(f.settings, { models: f.models }); await runtime.recover();
  await runtime.followUp(old.id, 'Historical follow-up', 'old');
  await until(() => runtime.status(old.id), row => row.status === 'answered' && row.submission?.requestId === 'user:old');
  await assert.rejects(runtime.searchHistory(old.id, 'saved'), /unavailable/);
});

test('delegated workers never inherit project history tools from their parent', async () => {
  let childCalls = 0;
  const f = await scriptedFixture(context => {
    if (!hasTool(context, 'delegate')) {
      childCalls++;
      assert(!hasTool(context, 'history_search')); assert(!hasTool(context, 'history_read'));
      return fauxAssistantMessage('Child evidence.');
    }
    assert(hasTool(context, 'history_search'));
    if (!context.messages.some(message => message.role === 'toolResult' && message.toolName === 'delegate')) return fauxAssistantMessage(fauxToolCall('delegate', {
      tasks: [{ name: 'worker', instructions: 'Inspect independent evidence.' }],
    }), { stopReason: 'toolUse' });
    return fauxAssistantMessage(fauxToolCall('task_submit', { summary: 'Used child evidence', artifacts: [] }), { stopReason: 'toolUse' });
  });
  try {
    const task = await f.runtime.create('Inspect with one worker.', f.workspace);
    await until(() => f.runtime.status(task.id), row => row.status === 'completed');
    assert.equal(childCalls, 1);
  } finally { await f.close(); }
});

test('an empty historical session fails explicitly instead of reporting no matching history', async t => {
  const f = await scriptedFixture(() => fauxAssistantMessage('Saved original history.'));
  let runtime = f.runtime;
  t.after(async () => { await runtime.close(); await f.close(); });
  const source = await runtime.create('HISTORY_ORIGINAL user discussion', f.workspace, [], { chat: true });
  await until(() => runtime.status(source.id), row => row.status === 'answered');
  await runtime.close();
  await writeFile(join(f.directory, 'tasks', source.id, 'session.sqlite'), '');
  runtime = new LocalRuntime(f.settings, { models: f.models });
  const caller = await runtime.create('Search the earlier discussion.', f.workspace, [], { chat: true });
  await until(() => runtime.status(caller.id), row => row.status === 'answered');
  await assert.rejects(runtime.searchHistory(caller.id, 'HISTORY_ORIGINAL'), /Historical Pi conversation is missing/);
});
