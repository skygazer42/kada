import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fauxAssistantMessage, fauxToolCall, type ToolResultMessage } from '@earendil-works/pi-ai';
import { hasTool, recoveryTestTimeoutMs, scriptedFixture, startRecoveryWorker, until } from './helpers.js';

const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' });
const text = (value: unknown) => typeof value === 'string' ? value : JSON.stringify(value ?? '');
const answerFor = (context: Parameters<Parameters<typeof scriptedFixture>[0]>[0], name: string) =>
  context.messages.findLast(message => message.role === 'toolResult' && message.toolName === name);

test('related notes are durable, deduplicated and available to the next owner turn without answering a pending question', async t => {
  let targetId: string, sourceId: string, unrelated: string, targetCalls = 0, readNotes = false;
  const f = await scriptedFixture(context => {
    const input = text(context.messages.findLast(message => message.role === 'user')?.content);
    if (input.includes('Owner answer ONE')) {
      targetCalls++;
      assert(input.includes('NOTE_WITHOUT_WAKE') && input.includes('NOTE_WHILE_WAITING') && input.includes(sourceId));
      readNotes = true;
      return fauxAssistantMessage('Owner answer and notes received.');
    }
    if (input === 'Ask the owner to choose a record.') {
      targetCalls++;
      return answerFor(context, 'ask_user') ? fauxAssistantMessage('Waiting for the owner.')
        : call('ask_user', { question: 'Which record?', options: ['One', 'Two'] });
    }
    if (input === 'Post the requested notes.') {
      const results = context.messages.filter((message): message is ToolResultMessage => message.role === 'toolResult' && message.toolName === 'post_to_thread');
      const first = { thread_id: targetId, message: 'NOTE_WITHOUT_WAKE', delivery_id: 'repeatable' };
      const requests = [first, first, { ...first, message: 'Different text' }, { ...first, thread_id: unrelated },
        { thread_id: targetId, message: 'NOTE_WHILE_WAITING', wake: true }];
      if (results.length < requests.length) return call('post_to_thread', requests[results.length]!);
      assert.deepEqual(results.map(message => message.isError), [false, false, true, true, false]);
      assert.equal(JSON.stringify(results[0]?.content), JSON.stringify(results[1]?.content));
      return fauxAssistantMessage('Requested notes saved.');
    }
    return fauxAssistantMessage('Ready.');
  });
  t.after(() => f.close());
  const role = await f.runtime.assistants.create({ workspace: f.workspace, name: 'Thread notifier', instructions: 'Share explicitly requested information.', tools: ['post_to_thread'] });
  const assistant = { id: role.id, revision: role.revision };
  sourceId = (await f.runtime.create('Source conversation.', f.workspace, [], { chat: true, assistant })).id;
  targetId = (await f.runtime.create('Ask the owner to choose a record.', f.workspace, [], { chat: true, assistant })).id;
  unrelated = (await f.runtime.create('Unrelated conversation.', f.workspace, [], { chat: true })).id;
  const waiting = await until(() => f.runtime.status(targetId), state => state.status === 'waiting_user');
  await until(() => f.runtime.status(sourceId), state => state.status === 'answered');
  const before = targetCalls;
  await f.runtime.followUp(sourceId, 'Post the requested notes.', 'post-request');
  const source = await until(() => f.runtime.status(sourceId), state => ['answered', 'failed'].includes(state.status) && state.submission?.requestId === 'user:post-request');
  assert.equal(source.status, 'answered', JSON.stringify(source.messages.filter(message => message.role === 'toolResult')));
  const posted = await f.runtime.status(targetId);
  assert.deepEqual(posted.threadPosts.map(post => post.message), ['NOTE_WITHOUT_WAKE', 'NOTE_WHILE_WAITING']);
  assert(posted.threadPosts.every(post => post.wake === 'stored' && post.sourceTaskId === sourceId));
  assert.equal(posted.userQuestion?.id, waiting.userQuestion?.id);
  assert.equal(posted.submission?.id, waiting.submission?.id);
  assert.equal(targetCalls, before);
  assert.deepEqual((await f.runtime.status(unrelated)).threadPosts, []);
  await f.runtime.answerQuestion(targetId, waiting.userQuestion!.id, 'reply-one', 'Owner answer ONE');
  await until(() => f.runtime.status(targetId), state => state.status === 'answered');
  assert(readNotes);
});

test('waking a completed independent task adds a text reply while retaining its confirmed delivery', async t => {
  let child: string, wakeReplies = 0;
  const f = await scriptedFixture(context => {
    const input = text(context.messages.findLast(message => message.role === 'user')?.content);
    if (input.includes('THREAD_POST_WAKE')) {
      assert(input.includes('POST_DELIVERY_EVIDENCE'));
      const prior = context.messages.filter((message): message is ToolResultMessage => message.role === 'toolResult' && message.toolName === 'task_submit');
      if (!prior.some(message => message.isError)) return call('task_submit', { summary: 'Do not replace the result.', artifacts: [] });
      wakeReplies++;
      return fauxAssistantMessage('I saw the note about the confirmed delivery.');
    }
    if (hasTool(context, 'task_submit')) return call('task_submit', { summary: 'Original delivery.', artifacts: [],
      criteria: [{ id: 1, status: 'passed', evidence: 'Original delivery.' }] });
    if (input === 'Prepare a text result.') return call('task_prepare', { outcome: 'Deliver a text result', deliverables: ['Text'], inputs: [],
      criteria: [{ text: 'Text received', method: 'inspect' }], scope: ['Fixture'], assumptions: [], questions: [] });
    if (input === 'Send a note and wake the original work.' && !answerFor(context, 'post_to_thread')) {
      return call('post_to_thread', { thread_id: child, message: 'POST_DELIVERY_EVIDENCE', wake: true });
    }
    return fauxAssistantMessage('Ready.');
  });
  t.after(() => f.close());
  const source = await f.runtime.create('Original discussion.', f.workspace, [], { chat: true });
  child = (await f.runtime.startThread(source.id, { title: 'Delivered work', message: 'Prepare a text result.', requestId: 'wake-child' })).id;
  const ready = await until(() => f.runtime.status(child), state => state.status === 'awaiting_confirmation');
  await f.runtime.confirm(child, ready.goal!.brief!.revision, ready.briefDigest!);
  const delivered = await until(() => f.runtime.status(child), state => state.status === 'completed');
  await until(() => f.runtime.status(source.id), state => state.status === 'answered');
  await f.runtime.followUp(source.id, 'Send a note and wake the original work.', 'wake-post');
  const final = await until(() => f.runtime.status(child), state => state.threadPosts?.[0]?.reply === 'I saw the note about the confirmed delivery.');
  assert.equal(final.threadPosts[0]?.wake, 'started');
  assert.equal(final.status, 'completed');
  assert.deepEqual(final.goal, delivered.goal);
  assert.equal(final.submission?.id, delivered.submission?.id);
  assert.equal(wakeReplies, 1);
});

test('a requested wake waits for the running turn and yields to a new owner turn', async t => {
  const running = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), woke = Promise.withResolvers<void>();
  const events: string[] = [];
  let target: string;
  const f = await scriptedFixture(async (context, signal) => {
    const input = text(context.messages.findLast(message => message.role === 'user')?.content);
    if (input === 'Existing target turn.') {
      events.push('original'); running.resolve(); await release.promise;
    } else if (input.includes('THREAD_POST_WAKE')) {
      events.push('wake'); woke.resolve();
      if (signal && !signal.aborted) await new Promise<void>(done => signal.addEventListener('abort', () => done(), { once: true }));
    } else if (input.includes('Continue with the owner.')) events.push('owner');
    else if (input === 'Post to the busy target.' && !answerFor(context, 'post_to_thread')) {
      return call('post_to_thread', { thread_id: target, message: 'Busy target fixture.', wake: true });
    }
    return fauxAssistantMessage('Turn handled.');
  });
  t.after(async () => { release.resolve(); await f.close(); });
  const role = await f.runtime.assistants.create({ workspace: f.workspace, name: 'Post operator', instructions: 'Share requested notes.', tools: ['post_to_thread'] });
  const assistant = { id: role.id, revision: role.revision };
  const source = await f.runtime.create('Source standby.', f.workspace, [], { chat: true, assistant });
  target = (await f.runtime.create('Existing target turn.', f.workspace, [], { chat: true, assistant })).id;
  await running.promise;
  await until(() => f.runtime.status(source.id), state => state.status === 'answered');
  await f.runtime.followUp(source.id, 'Post to the busy target.', 'busy-post');
  const queued = await until(() => f.runtime.status(target), state => state.threadPosts.length === 1);
  assert.equal(queued.threadPosts[0]?.wake, 'queued');
  assert.deepEqual(events, ['original']);
  release.resolve();
  await woke.promise;
  await f.runtime.followUp(target, 'Continue with the owner.', 'owner-priority');
  const answered = await until(() => f.runtime.status(target), state => state.status === 'answered' && state.submission?.requestId === 'user:owner-priority');
  assert.deepEqual(events, ['original', 'wake', 'owner']);
  assert.equal(answered.threadPosts.length, 1);
});

test('SIGKILL after native wake admission preserves one note and the original completed task', { timeout: recoveryTestTimeoutMs }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'kada-thread-post-')));
  const fixture = new URL('./fixtures/thread-post-recovery-worker.ts', import.meta.url);
  let worker = startRecoveryWorker(fixture, 'create', directory);
  try {
    const admitted = await worker.ready();
    assert.equal(await worker.stop(), 'SIGKILL');
    worker = startRecoveryWorker(fixture, 'recover', directory);
    const verified = await worker.complete();
    assert.equal(verified.wakeSubmission, admitted.wakeSubmission);
    assert.equal(verified.originalDelivery, admitted.originalDelivery);
    assert.equal(verified.notes, 1);
    assert.equal(verified.wakes, 1);
    assert.equal(verified.reply, 'Original note received after recovery.');
  } finally { await worker.stop(); await rm(directory, { recursive: true, force: true, maxRetries: 5 }); }
});
