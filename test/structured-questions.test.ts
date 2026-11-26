import assert from 'node:assert/strict';
import test from 'node:test';
import { fauxAssistantMessage, fauxToolCall, type TranscriptContext } from '@earendil-works/pi-ai';
import { LocalRuntime } from '../src/runtime.js';
import { ChatSession } from '../src/chat.js';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { serve } from '../src/server.js';
import { createServer } from 'node:net';
import { GoalDoc } from '../src/goal.js';
import { hasTool, scriptedFixture, until } from './helpers.js';

const call = (name: string, args: Record<string, unknown>) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' });
const users = (context: TranscriptContext) => context.messages.filter(message => message.role === 'user').map(message => String(message.content));

test('a normal chat asks choices without a Goal and answers the original question once after restart', async t => {
  let calls = 0;
  const f = await scriptedFixture(context => {
    calls++;
    assert(hasTool(context, 'ask_user'));
    if (users(context).includes('CSV')) return fauxAssistantMessage('已选择 CSV。');
    return call('ask_user', { question: '选择格式？', options: ['CSV', 'XLSX'], detail: '只选择格式，不执行导出。' });
  });
  let runtime = f.runtime;
  t.after(async () => { await runtime.close(); await f.close(); });
  const chat = await runtime.create('选择格式', f.workspace, [], { chat: true });
  const waiting = await until(() => runtime.status(chat.id), row => row.status === 'waiting_user' || row.status === 'failed');
  assert.equal(waiting.status, 'waiting_user'); assert.equal(waiting.goal, undefined);
  assert.deepEqual(waiting.userQuestion?.options, ['CSV', 'XLSX']);
  const question = waiting.userQuestion!;
  assert.equal(question.text, '选择格式？'); assert.equal(question.detail, '只选择格式，不执行导出。');
  await runtime.close(); runtime = new LocalRuntime(f.settings, { models: f.models }); await runtime.recover();
  assert.equal(calls, 1); assert.deepEqual((await runtime.status(chat.id)).userQuestion, question);
  await runtime.answerQuestion(chat.id, question.id, 'choose-format', 'CSV');
  const answered = await until(() => runtime.status(chat.id), row => row.status === 'answered');
  assert.equal(answered.goal, undefined); assert.equal(answered.userQuestion, null);
  await runtime.answerQuestion(chat.id, question.id, 'choose-format', 'CSV'); assert.equal(calls, 2);
  await assert.rejects(runtime.answerQuestion(chat.id, question.id, 'choose-format', 'XLSX'), { status: 409 });
  assert.equal((await runtime.status(chat.id)).messages.filter(message => message.role === 'user' && message.content === 'CSV').length, 1);
});

test('plain text answers retire the original choice and stale clicks cannot answer a replacement question', async t => {
  const f = await scriptedFixture(context => {
    if (users(context).includes('Use JSON instead.')) return call('ask_user', { question: '是否缩进？', options: ['是', '否'] });
    return call('ask_user', { question: '选择格式？', options: ['CSV', 'XLSX'] });
  });
  t.after(() => f.close());
  const chat = await f.runtime.create('选择格式', f.workspace, [], { chat: true });
  const first = await until(() => f.runtime.status(chat.id), row => row.status === 'waiting_user' || row.status === 'failed');
  assert.equal(first.status, 'waiting_user');
  await f.runtime.followUp(chat.id, 'Use JSON instead.', 'free-text');
  const second = await until(() => f.runtime.status(chat.id), row => row.status === 'waiting_user' && row.userQuestion?.id !== first.userQuestion!.id);
  assert.equal(second.userQuestion!.text, '是否缩进？');
  await assert.rejects(f.runtime.answerQuestion(chat.id, first.userQuestion!.id, 'late-click', 'CSV'), { status: 409 });
  await f.runtime.pause(chat.id);
  await assert.rejects(f.runtime.answerQuestion(chat.id, second.userQuestion!.id, 'paused', '是'), { status: 409 });
});

test('execution choice preserves the same Goal, original budget and checked delivery', async t => {
  const f = await scriptedFixture(context => {
    if (users(context).includes('CSV')) return call('task_submit', { summary: 'Selected CSV.', artifacts: [] });
    return call('ask_user', { question: '选择格式？', options: ['CSV', 'XLSX'] });
  });
  t.after(() => f.close());
  const task = await f.runtime.create('Ask then report.', f.workspace);
  const before = await until(() => f.runtime.status(task.id), row => row.status === 'waiting_user' || row.status === 'failed');
  assert.equal(before.status, 'waiting_user'); assert(before.goal);
  await f.runtime.answerQuestion(task.id, before.userQuestion!.id, 'execution-choice', 'CSV');
  const after = await until(() => f.runtime.status(task.id), row => row.status === 'completed');
  assert.equal(after.deadlineAt, before.deadlineAt); assert.equal(after.budget.costLimit, before.budget.costLimit);
  assert.deepEqual(after.goal?.userMessages, ['CSV']); assert.equal(after.goal?.revision, before.goal!.revision + 1);
  await f.runtime.answerQuestion(task.id, before.userQuestion!.id, 'execution-choice', 'CSV');
  assert.equal((await f.runtime.status(task.id)).goal?.revision, after.goal?.revision);
});

test('blank, duplicate or malformed choices fail visibly without saving a question', async t => {
  let next = 0;
  const f = await scriptedFixture(context => {
    const invalid = [{ question: ' ', options: ['A', 'B'] }, { question: 'Question', options: ['A', ' A '] },
      { question: 'Question', options: ['A'] }, { question: 'Question', options: ['A', 'B'], detail: '\0' }];
    const results = context.messages.filter(message => message.role === 'toolResult');
    if (results.length) assert.equal(results.at(-1)!.isError, true);
    return next < invalid.length ? call('ask_user', invalid[next++]!) : fauxAssistantMessage('Invalid questions rejected.');
  });
  t.after(() => f.close());
  const chat = await f.runtime.create('Validate choices.', f.workspace, [], { chat: true });
  const answer = await until(() => f.runtime.status(chat.id), row => ['answered', 'failed'].includes(row.status));
  assert.equal(answer.status, 'answered'); assert.equal(next, 4); assert.equal(answer.userQuestion, null); assert.equal(answer.goal, undefined);
});

test('a background child offers choices on its own original question and resumes once', async t => {
  const f = await scriptedFixture(context => {
    if (hasTool(context, 'delegation_ask') && !hasTool(context, 'delegate')) {
      assert(!hasTool(context, 'ask_user'));
      const offered = context.messages.find(message => message.role === 'system' && message.toolsAdded?.some(tool => tool.name === 'delegation_ask'));
      assert(offered?.role === 'system' && JSON.stringify(offered.toolsAdded).includes('options'));
      if (users(context).includes('CSV')) return fauxAssistantMessage('Selected CSV.');
      return call('delegation_ask', { question: 'Which format?', options: ['CSV', 'XLSX'], detail: 'Choose one format.' });
    }
    if (users(context).some(text => text.startsWith('Background delegation finished.'))) return call('task_submit', { summary: 'Selected CSV.', artifacts: [] });
    if (!context.messages.some(message => message.role === 'toolResult' && message.toolName === 'delegate_background')) return call('delegate_background', { tasks: [{ name: 'reader', instructions: 'Ask which format.' }] });
    return fauxAssistantMessage('Waiting for the original child.');
  });
  t.after(() => f.close());
  const task = await f.runtime.create('Get a format from the worker.', f.workspace);
  const waiting = await until(() => f.runtime.status(task.id), row => !!row.delegations[0]?.question);
  const child = waiting.delegations[0];
  assert.deepEqual(child.question?.options, ['CSV', 'XLSX']); assert.equal(child.question?.detail, 'Choose one format.');
  await f.runtime.answerChildQuestion(task.id, child.conversationId, child.question!.id, 'child-choice', 'CSV');
  await until(() => f.runtime.status(task.id), row => row.status === 'completed');
});

test('the terminal shows question choices and sends a selected option to the displayed original question', async t => {
  const f = await scriptedFixture(context => users(context).includes('CSV') ? fauxAssistantMessage('Selected CSV.') : call('ask_user', { question: 'Which format?', options: ['CSV', 'XLSX'] }));
  t.after(() => f.close());
  const chat = await f.runtime.create('Choose format.', f.workspace, [], { chat: true });
  const waiting = await until(() => f.runtime.status(chat.id), row => row.status === 'waiting_user');
  const sent: unknown[] = [], output: string[] = [];
  const terminal = new ChatSession({ healthy: async () => true, request: async <T>(path: string, method = 'GET', input?: unknown): Promise<T> => {
    if (path.endsWith('/notifications/read')) return undefined as T;
    if (method === 'GET') return await f.runtime.status(chat.id) as T;
    sent.push({ path, input });
    const { requestId, answer } = input as { requestId: string; answer: string };
    await f.runtime.answerQuestion(chat.id, waiting.userQuestion!.id, requestId, answer);
    return {} as T;
  } }, event => output.push(event.text));
  await terminal.attach(chat.id);
  assert.match(output.join('\n'), /Which format\?[\s\S]*1.*CSV[\s\S]*2.*XLSX/);
  await terminal.handle('/choose ' + waiting.userQuestion!.id + ' 1');
  assert.equal((sent[0] as { input: { answer: string } }).input.answer, 'CSV');
  await until(() => f.runtime.status(chat.id), row => row.status === 'answered');
  await assert.rejects(terminal.handle('/choose ' + waiting.userQuestion!.id + ' 2'), /问题|question/);
});

test('a passive Pi write cannot hide an unanswered question, and request IDs cannot move to another question', async t => {
  const f = await scriptedFixture(c => call('ask_user', { question: users(c).includes('CSV') ? 'Indent?' : 'Format?', options: ['CSV', 'XLSX'] }));
  t.after(() => f.close());
  const chat = await f.runtime.create('Choose.', f.workspace, [], { chat: true });
  const first = await until(() => f.runtime.status(chat.id), row => row.status === 'waiting_user');
  const active = f.runtime['active'].get(chat.id)!;
  for (let index = 0; index < 205; index++) await (await active.root.submit({ type: 'write', entry: { kind: 'local.passive', data: { notice: 'A passive stored event.', index } } }, context)).wait(context);
  assert.deepEqual((await f.runtime.status(chat.id)).userQuestion, first.userQuestion);
  await f.runtime.answerQuestion(chat.id, first.userQuestion!.id, 'same-key', 'CSV');
  const second = await until(() => f.runtime.status(chat.id), row => row.status === 'waiting_user' && row.userQuestion?.id !== first.userQuestion!.id);
  await assert.rejects(f.runtime.answerQuestion(chat.id, second.userQuestion!.id, 'same-key', 'XLSX'), { status: 409 });
});

test('a preparation choice needs separate brief confirmation, while historical sessions do not acquire ask_user', async t => {
  const f = await scriptedFixture(c => {
    if (users(c).includes('Historical')) { assert(!hasTool(c, 'ask_user')); return fauxAssistantMessage('Historical.'); }
    if (!users(c).includes('CSV')) return call('ask_user', { question: 'Format?', options: ['CSV', 'XLSX'] });
    if (hasTool(c, 'task_prepare')) return call('task_prepare', { outcome: 'Export CSV', deliverables: ['Report'], inputs: [],
      criteria: [{ text: 'Report returned', method: 'inspect' }], scope: ['Read project'], assumptions: [], questions: [] });
    return fauxAssistantMessage('No execution requested.');
  });
  let runtime = f.runtime;
  t.after(async () => { await runtime.close(); await f.close(); });
  const prep = await runtime.create('Prepare export.', f.workspace, [], { prepare: true });
  const waiting = await until(() => runtime.status(prep.id), row => row.status === 'clarifying');
  await runtime.answerQuestion(prep.id, waiting.userQuestion!.id, 'prep-answer', 'CSV');
  const brief = await until(() => runtime.status(prep.id), row => row.status === 'awaiting_confirmation');
  assert.equal(brief.goal?.confirmation, undefined); assert.equal(brief.goal?.candidate, null);
  const old = await runtime.create('Choose old.', f.workspace, [], { chat: true });
  await until(() => runtime.status(old.id), row => row.status === 'waiting_user');
  const meta = await runtime.metadata(old.id); delete meta.structuredQuestions;
  await runtime.close(); await writeFile(join(f.directory, 'tasks', old.id, 'task.json'), JSON.stringify(meta));
  runtime = new LocalRuntime(f.settings, { models: f.models }); await runtime.recover();
  await runtime.followUp(old.id, 'Historical', 'old');
  await until(() => runtime.status(old.id), row => row.status === 'answered');
});

test('owner and shared-run APIs bind choices to the original question and retain existing share permissions', async t => {
  const f = await scriptedFixture(c => users(c).includes('CSV') ? call('task_submit', { summary: 'Selected CSV.', artifacts: [] }) : call('ask_user', { question: 'Format?', options: ['CSV', 'XLSX'] }));
  const socket = createServer(); await new Promise<void>(done => socket.listen(0, '127.0.0.1', done));
  const port = (socket.address() as { port: number }).port; await new Promise<void>(done => socket.close(() => done()));
  const server = await serve({ ...f.settings, port }, { models: f.models });
  t.after(async () => { await server.close(); await f.close(); });
  const token = (await readFile(join(f.directory, 'token'), 'utf8')).trim();
  const request = (bearer: string, path: string, data?: object) => fetch('http://127.0.0.1:' + port + path, {
    method: data ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + bearer, 'Content-Type': 'application/json' }, body: data ? JSON.stringify(data) : undefined,
  });
  const phone = await (await request(token, '/v1/remote/devices', { accountId: 'owner', deviceId: 'phone' })).json();
  const item = await server.runtime.workItems.create({ workspace: f.workspace, title: 'Choose format', objective: 'Choose format.' });
  const run = await server.runtime.workItems.run(item.id, { revision: 1, requestId: 'original', confirmed: true });
  const waiting = await until(() => server.runtime.status(run.id), row => row.status === 'waiting_user' && row.submission?.status === 'done');
  const path = '/remote/api/work-items/' + item.id + '/runs/' + run.id;
  await request(token, '/v1/work-items/' + item.id + '/share', { accountId: 'owner', deviceId: 'phone' });
  const read = await (await request(phone.token, path)).json();
  assert.deepEqual(read.userQuestion.options, ['CSV', 'XLSX']); assert.equal(read.answerVersion, null);
  assert.equal((await request(phone.token, path + '/answers', { requestId: 'answer', answer: 'CSV', version: '0'.repeat(64) })).status, 403);
  await request(token, '/v1/work-items/' + item.id + '/share-replies', { accountId: 'owner', deviceId: 'phone' });
  const permitted = await (await request(phone.token, path)).json();
  const input = { requestId: 'answer', answer: 'CSV', version: permitted.answerVersion };
  assert.equal((await request(phone.token, path + '/answers', input)).status, 200);
  await until(() => server.runtime.status(run.id), row => row.status === 'completed');
  assert.equal((await request(phone.token, path + '/answers', input)).status, 200);
  const second = await server.runtime.create('Another choice.', f.workspace);
  const choice = await until(() => server.runtime.status(second.id), row => row.status === 'waiting_user' && row.submission?.status === 'done');
  const route = '/v1/tasks/' + second.id + '/questions/' + choice.userQuestion!.id + '/answer';
  assert.equal((await request('invalid-owner', route, { requestId: 'owner-answer', answer: 'CSV' })).status, 401);
  assert.equal((await request(token, route, { requestId: 'owner-answer', answer: 'CSV' })).status, 200);
  await until(() => server.runtime.status(second.id), row => row.status === 'completed');
  assert.equal((await request(token, route, { requestId: 'owner-answer', answer: 'XLSX' })).status, 409);
  assert.equal(waiting.goal?.confirmation, undefined);
});

test('expired execution budgets and cancelled tasks reject new choice answers', async t => {
  const f = await scriptedFixture(() => call('ask_user', { question: 'Format?', options: ['CSV', 'XLSX'] }));
  t.after(() => f.close());
  const task = await f.runtime.create('Ask.', f.workspace);
  const waiting = await until(() => f.runtime.status(task.id), row => row.status === 'waiting_user' && row.submission?.status === 'done');
  const active = f.runtime['active'].get(task.id)!;
  await active.harness.commit(async tx => { (await tx.doc(GoalDoc)).tokenLimit = 1; }, context);
  await assert.rejects(f.runtime.answerQuestion(task.id, waiting.userQuestion!.id, 'exhausted', 'CSV'), { status: 409 });
  await f.runtime.cancel(task.id);
  await assert.rejects(f.runtime.answerQuestion(task.id, waiting.userQuestion!.id, 'cancelled', 'CSV'), { status: 409 });
});
