import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { ChatSession } from '../src/chat.js';
import { createClient, type TaskStatus } from '../src/client.js';
import { serve } from '../src/server.js';
import { hasTool, recoveryTestTimeoutMs, scriptedFixture, startRecoveryWorker, until } from './helpers.js';

const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' });
const brief = { outcome: '核对合成样本', deliverables: ['文本报告'], inputs: [], criteria: [{ text: '核对样本', method: 'inspect' }],
  scope: ['本机测试项目'], assumptions: [], questions: [] };

test('the owner opens, names, archives and restores an independent task through the normal terminal', async t => {
  let actions = 0;
  const f = await scriptedFixture(context => {
    const message = context.messages.findLast(message => message.role === 'user');
    if (hasTool(context, 'task_submit')) {
      actions++;
      return call('task_submit', { summary: '合成样本已核对。', artifacts: [], criteria: [{ id: 1, status: 'passed', evidence: '核对合成样本。' }] });
    }
    if (message?.content === '核对合成样本') {
      assert(!JSON.stringify(context.messages.filter(item => item.role === 'user')).includes('SOURCE_ONLY_826'));
      return call('task_prepare', brief);
    }
    return fauxAssistantMessage('这是原对话。');
  });
  await f.runtime.close();
  const socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const settings = { ...f.settings, port };
  let server = await serve(settings, { models: f.models });
  t.after(async () => { await server.close(); await f.close(); });
  const client = createClient(settings), events: string[] = [];
  let acceptedRequest: string | undefined;
  const chat = new ChatSession({ healthy: client.healthy, async request<T>(path: string, method?: string, value?: unknown) {
    const result = await client.request<T>(path, method, value);
    if (path.endsWith('/threads') && !acceptedRequest) {
      acceptedRequest = (value as { requestId: string }).requestId;
      throw new Error('Lost thread response.');
    }
    return result;
  } }, event => events.push(event.text), f.workspace);
  await chat.handle('SOURCE_ONLY_826');
  const parent = chat.taskId!;
  await until(() => server.runtime.status(parent), state => state.status === 'answered');
  const parentPath = '/v1/tasks/' + parent;
  assert.equal((await fetch(`http://127.0.0.1:${port}${parentPath}/threads`, { method: 'POST' })).status, 401);
  await assert.rejects(chat.handle('/thread 独立核对 | 核对合成样本'), /Lost thread response/);
  assert.equal(chat.taskId, parent);
  await chat.handle('/thread 独立核对 | 核对合成样本');
  const id = chat.taskId!;
  const path = '/v1/tasks/' + id;
  assert.notEqual(id, parent);
  const prepared = await until(() => server.runtime.status(id), state => state.status === 'awaiting_confirmation');
  assert.equal(prepared.workspace, f.workspace);
  assert.equal(prepared.thread?.sourceTaskId, parent);
  assert.equal(prepared.thread?.title, '独立核对');
  assert.equal((await server.runtime.list()).length, 2);
  await assert.rejects(client.request(parentPath + '/threads', 'POST', { title: 'Changed', message: 'Changed', requestId: acceptedRequest }), /different request/i);
  assert.equal(actions, 0);
  await assert.rejects(chat.handle('/archive'), /archive|归档/i);
  await chat.poll();
  await chat.handle('/confirm');
  const delivered = await until(() => server.runtime.status(id), state => state.status === 'completed');
  const originalSubmission = delivered.submission?.id;
  const originalBudget = delivered.budget.totalTokens;
  await chat.handle('/title 样本报告');
  await assert.rejects(client.request(path + '/thread', 'PATCH', { title: 'Stale edit', revision: 1 }), /current revision/i);
  await chat.handle('/archive');
  assert(!(await server.runtime.list()).some(task => task.id === id));
  assert.equal((await server.runtime.list('archived'))[0]?.id, id);
  assert.equal((await server.runtime.projectTasks(parent)).tasks.some(task => task.id === id), false);
  assert.equal((await server.runtime.projectTasks(parent, 'archived')).tasks[0]?.id, id);
  await assert.rejects(client.request(path + '/messages', 'POST', { message: 'An archived task must stay idle.' }), /archived/i);
  await server.close();
  server = await serve(settings, { models: f.models });
  await chat.handle('/tasks archived');
  assert(events.some(text => text.includes('样本报告') && text.includes(id)));
  await chat.attach(id);
  await chat.handle('/unarchive');
  const restored = await client.request<TaskStatus>(path);
  assert.equal(restored.thread?.archivedAt, undefined);
  assert.equal(restored.thread?.title, '样本报告');
  assert.equal(restored.status, 'completed');
  assert.equal(restored.submission?.id, originalSubmission);
  assert.equal(restored.budget.totalTokens, originalBudget);
  assert.equal(actions, 1);
  assert.equal((await server.runtime.status(parent)).status, 'answered');
  assert.deepEqual((await server.runtime.status(parent)).threadReports, []);
  await chat.attach(parent);
  await chat.handle('/thread-report 带回报告 | 核对合成样本');
  const reporting = chat.taskId!;
  const pending = await until(() => server.runtime.status(reporting), status => status.status === 'awaiting_confirmation');
  assert.equal(pending.thread?.reportBack, true);
  await chat.poll();
  await chat.handle('/confirm');
  await until(() => server.runtime.status(parent), status => status.threadReports.some(report => report.taskId === reporting));
  await chat.attach(parent);
  await chat.poll();
  assert.equal(events.filter(text => text.includes('独立工作回传') && text.includes(`/attach ${reporting}`)).length, 1);
});

test('the chat tool prepares one independent thread for its original Pi input', async t => {
  let prepared = 0;
  const parentAnswer = Promise.withResolvers<void>();
  const input = { title: '阅读样本', message: '准备合成任务', report_back: true };
  const f = await scriptedFixture(async context => {
    const latest = context.messages.findLast(message => message.role === 'user');
    if (latest?.content === input.message) {
      assert(hasTool(context, 'task_prepare'));
      assert(!hasTool(context, 'task_submit') && !hasTool(context, 'start_thread'));
      prepared++;
      return call('task_prepare', brief);
    }
    if (latest?.content === 'Remote private check') {
      assert(!hasTool(context, 'start_thread'));
      return fauxAssistantMessage('Remote only.');
    }
    assert(hasTool(context, 'start_thread'));
    const results = context.messages.filter(message => message.role === 'toolResult' && message.toolName === 'start_thread');
    if (results.length < 2) return call('start_thread', input);
    await parentAnswer.promise;
    return fauxAssistantMessage('已打开该独立会话。');
  });
  t.after(async () => { parentAnswer.resolve(); await f.close(); });
  const parent = await f.runtime.create('请在新会话中阅读这份样本。', f.workspace, [], { chat: true });
  const running = await until(() => f.runtime.status(parent.id), state => state.messages.filter(message => message.role === 'toolResult' && message.toolName === 'start_thread').length === 2);
  const toolResults = running.messages.flatMap(message => message.role === 'toolResult' && message.toolName === 'start_thread' ? [message] : []);
  assert.equal(toolResults.length, 2);
  assert(toolResults.every(message => !message.isError), JSON.stringify(toolResults.map(message => message.content)));
  const project = (await f.runtime.list()).find(task => task.thread?.sourceTaskId === parent.id);
  assert(project);
  const child = await until(() => f.runtime.status(project.id), state => state.status === 'awaiting_confirmation');
  const events: string[] = [];
  const terminal = new ChatSession({ healthy: async () => true, async request<T>(path: string) {
    if (path.endsWith('/notifications/read')) return {} as T;
    assert.equal(path, '/v1/tasks/' + parent.id);
    return await f.runtime.status(parent.id) as T;
  } }, event => events.push(event.text), f.workspace);
  await terminal.attach(parent.id);
  await terminal.poll();
  assert.equal(events.filter(text => text.includes('/attach ' + child.id)).length, 1);
  assert.equal((await f.runtime.status(parent.id)).status, 'running');
  parentAnswer.resolve();
  const answered = await until(() => f.runtime.status(parent.id), state => state.status === 'answered');
  assert.equal(child.thread?.openedBy, 'assistant');
  assert.equal(child.thread?.reportBack, true);
  assert.deepEqual(child.model, parent.model);
  assert.equal(prepared, 1);
  assert.equal((await f.runtime.list()).length, 2);
  assert.equal(answered.goal, undefined);
  const remote = await f.runtime.create('Remote private check', f.workspace, [], { chat: true, remote: true });
  await until(() => f.runtime.status(remote.id), state => state.status === 'answered');
  await assert.rejects(f.runtime.startThread(remote.id, { title: input.title, message: input.message, reportBack: true, requestId: 'remote-new' }), /remote/i);
});

test('SIGKILL after recording an assistant-opened thread preserves its identity and initial input', { timeout: recoveryTestTimeoutMs }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'kada-thread-recovery-')));
  const fixture = new URL('./fixtures/thread-recovery-worker.ts', import.meta.url);
  let worker = startRecoveryWorker(fixture, 'create', directory);
  try {
    const admitted = await worker.ready();
    assert.equal(await worker.stop(), 'SIGKILL');
    worker = startRecoveryWorker(fixture, 'recover', directory);
    const result = await worker.complete();
    assert.equal(result.id, admitted.id);
    assert.equal(result.parent, admitted.parent);
    assert.equal(result.receipt, admitted.id);
    assert.equal(result.threads, 2);
    assert.equal(result.preparations, 'prepare\n');
    assert.equal(result.inputs, 1);
    assert.equal(result.confirmed, false);
  } finally { await worker.stop(); await rm(directory, { recursive: true, force: true, maxRetries: 5 }); }
});
