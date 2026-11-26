import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxToolCall, type ToolResultMessage } from '@earendil-works/pi-ai';
import { ChatSession } from '../src/chat.js';
import { createClient } from '../src/client.js';
import { LocalRuntime } from '../src/runtime.js';
import { serve } from '../src/server.js';
import { hasTool, scriptedFixture, until } from './helpers.js';

const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' });

test('confirmed local task exposes only the selected assistant and the terminal answers its original pending work after daemon recovery', { timeout: 40_000 }, async t => {
  let permitted: { id: string; revision: number }, unexpected: { id: string; revision: number }, peerTurns = 0;
  const f = await scriptedFixture(context => {
    const latest = context.messages.filter(message => message.role === 'user').at(-1)?.content;
    const round = context.messages.slice(context.messages.findLastIndex(message => message.role === 'user'));
    if (JSON.stringify(context.messages.filter(message => message.role === 'system')).includes('OWNER_PEER_912')) {
      peerTurns++;
      if (String(latest).startsWith('ASSISTANT_ANSWER ')) {
        assert(String(latest).includes('Use the blue dataset'));
        if (!round.some(message => message.role === 'toolResult' && message.toolName === 'read')) return call('read', { path: 'seed.txt' });
        return fauxAssistantMessage('PEER_REAL_ANSWER_912');
      }
      return call('assistant_ask', { question: '请选择资料。', options: ['Use the blue dataset', 'Use the green dataset'] });
    }
    if (hasTool(context, 'task_prepare')) {
      assert(!hasTool(context, 'assistant_assign'));
      return call('task_prepare', { outcome: '核对同事证据', deliverables: ['已核对的结果'], inputs: [], scope: ['读取合成文件'], assumptions: [], questions: [], criteria: [{ text: '实际核对原同事结果', method: 'inspect' }] });
    }
    if (String(latest).startsWith('ASSISTANT_QUESTION ')) return fauxAssistantMessage('正在等待你的选择。');
    if (String(latest).startsWith('ASSISTANT_REPORT ')) {
      const result = round.find(message => message.role === 'toolResult' && message.toolName === 'assistant_result');
      if (!result) return call('assistant_result', { id: JSON.parse(String(latest).slice('ASSISTANT_REPORT '.length)).id });
      assert(JSON.stringify(result).includes('PEER_REAL_ANSWER_912'));
      return call('task_submit', { summary: '原同事已核对蓝色资料。', artifacts: [], criteria: [{ id: 1, status: 'passed', evidence: 'Read the exact original answer PEER_REAL_ANSWER_912.' }] });
    }
    const directory = round.find(message => message.role === 'toolResult' && message.toolName === 'assistant_directory');
    if (!directory) return call('assistant_directory', {});
    assert(JSON.stringify(directory).includes(permitted.id)); assert(!JSON.stringify(directory).includes(unexpected.id));
    const attempts = round.filter((message): message is ToolResultMessage => message.role === 'toolResult' && message.toolName === 'assistant_assign');
    if (!attempts.length) return call('assistant_assign', { assistant: unexpected, instructions: 'Use the unapproved role.' });
    assert.equal(attempts[0]?.isError, true);
    if (attempts.length === 1) return call('assistant_assign', { assistant: permitted, instructions: 'Find out which dataset to read.', files: ['seed.txt'] });
    assert.equal(attempts[1]?.isError, false);
    return fauxAssistantMessage('已交给选定助手。');
  });
  await f.runtime.close();
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>(resolve => listener.close(() => resolve()));
  const config = { ...f.settings, port, maxDurationMs: 60_000 };
  let server = await serve(config, { models: f.models });
  t.after(async () => { await server.close(); await f.close(); });
  const client = () => createClient(config);
  const ref = ({ id, revision }: { id: string; revision: number }) => ({ id, revision });
  await writeFile(join(f.workspace, 'seed.txt'), 'blue dataset available');
  permitted = ref(await client().request('/v1/assistants', 'POST', { workspace: f.workspace, name: 'Reader', instructions: 'OWNER_PEER_912', tools: ['read', 'assistant_ask'] }));
  unexpected = ref(await client().request('/v1/assistants', 'POST', { workspace: f.workspace, name: 'Other', instructions: 'Other role.', tools: ['write'] }));
  const task = await client().request<Awaited<ReturnType<LocalRuntime['create']>>>('/v1/tasks', 'POST', {
    objective: '核对选定同事的资料结果。', workspace: f.workspace, collaborators: [permitted],
  });
  const path = `/v1/tasks/${task.id}`;
  const prepared = await until(() => server.runtime.status(task.id), status => status.status === 'awaiting_confirmation');
  assert.equal(peerTurns, 0);
  await client().request(path + '/confirm', 'POST', { revision: prepared.goal!.brief!.revision, digest: prepared.briefDigest });
  const waiting = await until(() => server.runtime.status(task.id), status => status.status === 'waiting_assistant');
  const [work] = waiting.assistantWork; assert(work); assert.equal(work.assistant.id, permitted.id);
  const otherTask = await client().request<Awaited<ReturnType<LocalRuntime['create']>>>('/v1/tasks', 'POST', {
    objective: '核对另一次确认的资料结果。', workspace: f.workspace, collaborators: [permitted],
  });
  const other = await until(() => server.runtime.status(otherTask.id), status => status.status === 'awaiting_confirmation');
  await client().request('/v1/tasks/' + other.id + '/confirm', 'POST', { revision: other.goal!.brief!.revision, digest: other.briefDigest });
  const otherWaiting = await until(() => server.runtime.status(other.id), status => status.status === 'waiting_assistant');
  const otherWork = otherWaiting.assistantWork[0]!;
  assert.notEqual(work.id, otherWork.id);
  assert.notEqual(work.files[0]!.path, otherWork.files[0]!.path);
  assert.equal(await readFile(otherWork.files[0]!.path, 'utf8'), 'blue dataset available');
  await assert.rejects(server.runtime.assistantResult(other.id, work.id), { status: 404 });
  await server.runtime.cancel(other.id);
  const question = work.questions[0]!; const originalDeadline = waiting.deadlineAt;
  const view = await client().request<{ assistantWork: typeof waiting.assistantWork }>(path + '/view');
  assert.equal(view.assistantWork[0]?.questions[0]?.text, '请选择资料。');
  await server.close(); server = await serve(config, { models: f.models });
  const reopened = await server.runtime.status(task.id);
  assert.equal(reopened.deadlineAt, originalDeadline); assert.equal(reopened.assistantWork[0]?.questions[0]?.id, question.id);
  const events: string[] = [], terminal = new ChatSession(client(), event => events.push(event.text), f.workspace);
  await terminal.attach(task.id); assert(events.some(text => text.includes('请选择资料。')));
  const answerPath = `${path}/assistant-work/${work.id}/questions/${question.id}/answer`;
  const unauthorized = await fetch(`http://127.0.0.1:${port}${answerPath}`, { method: 'POST' });
  assert.equal(unauthorized.status, 401);
  const invalid = await fetch(`http://127.0.0.1:${port}${answerPath.replace('/' + question.id + '/answer', '/999999/answer')}`, { method: 'POST',
    headers: { authorization: 'Bearer ' + (await readFile(join(f.directory, 'token'), 'utf8')).trim(), 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: 'old-question', answer: 'Use the blue dataset' }) });
  assert.equal(invalid.status, 409);
  await terminal.handle(`/reply-assistant ${work.id} ${question.id} Use the blue dataset`);
  const done = await until(() => server.runtime.status(task.id), status => ['completed', 'failed', 'needs_attention'].includes(status.status));
  assert.equal(done.status, 'completed'); assert.equal(done.deadlineAt, originalDeadline);
  assert.equal(done.assistantWork.length, 1); assert(done.assistantWork[0]!.usage.totalTokens > 0);
  assert(done.budget.totalTokens > done.assistantWork[0]!.usage.totalTokens);
  const count = peerTurns;
  await terminal.handle(`/reply-assistant ${work.id} ${question.id} Use the blue dataset`);
  const saved = await client().request<{ answer: string }>(`${path}/assistant-work/${work.id}`);
  assert.equal(saved.answer, 'PEER_REAL_ANSWER_912'); assert.equal(peerTurns, count);
});

test('explicit collaborators stay local and historical and ordinary chat tasks do not acquire execution tools', async t => {
  const f = await scriptedFixture(context => {
    assert(!hasTool(context, 'assistant_assign'));
    return hasTool(context, 'task_submit') ? call('task_submit', { summary: 'Original authorization retained.', artifacts: [] }) : fauxAssistantMessage('普通对话。');
  });
  t.after(() => f.close());
  const collaborator = await f.runtime.assistants.create({ workspace: f.workspace, name: 'Reader', instructions: 'Read evidence.', tools: ['read'] });
  const team = [{ id: collaborator.id, revision: collaborator.revision }];
  await assert.rejects(f.runtime.create('Remote.', f.workspace, [], { remote: true, collaborators: team }), { status: 400 });
  await assert.rejects(f.runtime.create('No workspace.', undefined, [], { collaborators: team }), { status: 400 });
  await assert.rejects(f.runtime.create('Changed member.', f.workspace, [], { collaborators: [{ ...team[0]!, revision: 2 }] }), { status: 409 });
  const id = randomUUID();
  await f.runtime.create('Ordinary chat.', f.workspace, [], { id, chat: true, collaborators: team });
  const chat = await until(() => f.runtime.status(id), status => status.status === 'answered');
  assert.equal(chat.goal, undefined); assert.deepEqual(chat.assistantWork, []);
  await assert.rejects(f.runtime.create('Ordinary chat.', f.workspace, [], { id, chat: true }), { status: 409 });
  const oldTask = await f.runtime.create('Explicit task without collaborators.', f.workspace);
  await until(() => f.runtime.status(oldTask.id), status => status.status === 'completed');
});
