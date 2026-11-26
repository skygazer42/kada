import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { hasTool, recoveryTestTimeoutMs, scriptedFixture, startRecoveryWorker, until } from './helpers.js';

const taskMessage = 'Inspect the synthetic evidence.';
const summary = 'The original evidence has total 42.';
const brief = { outcome: taskMessage, deliverables: ['Plain text'], inputs: [], criteria: [{ text: 'Total 42', method: 'inspect' }],
  scope: ['Synthetic workspace'], assumptions: [], questions: [] };
const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' });

test('ordinary chat lists related threads and archives only settled work under its authority', async t => {
  let settled: string, waiting: string, paused: string, unrelated: string, sourceId: string, sibling: string;
  const f = await scriptedFixture(context => {
    const input = context.messages.findLast(message => message.role === 'user')?.content;
    if (hasTool(context, 'task_submit')) return call('task_submit', { summary, artifacts: [], criteria: [{ id: 1, status: 'passed', evidence: summary }] });
    if (input === taskMessage) return call('task_prepare', brief);
    if (input !== 'Rename this chat and close the finished linked work.') return fauxAssistantMessage('Ready.');
    const results = context.messages.filter(message => message.role === 'toolResult');
    const directory = results.find(message => message.toolName === 'list_threads');
    if (!directory) return call('list_threads', {});
    assert(!directory.isError);
    const { current, threads } = JSON.parse(directory.content.map(part => part.type === 'text' ? part.text : '').join(''));
    assert.equal(current.id, sourceId);
    assert.equal(current.revision, 0);
    assert.deepEqual(threads.map((thread: { id: string }) => thread.id).sort(), [settled, waiting, paused, sibling].sort());
    assert.equal(threads.find((thread: { id: string }) => thread.id === settled).status, 'completed');
    assert.equal(threads.find((thread: { id: string }) => thread.id === waiting).status, 'awaiting_confirmation');
    const rename = results.find(message => message.toolName === 'rename_thread');
    if (!rename) return call('rename_thread', { title: 'Evidence review', revision: current.revision });
    assert(!rename.isError);
    const closes = results.filter(message => message.toolName === 'close_thread');
    const targets = [waiting, paused, unrelated, sourceId, settled, sibling];
    if (closes.length < targets.length) {
      const id = targets[closes.length]!;
      return call('close_thread', { thread_id: id, revision: threads.find((thread: { id: string }) => thread.id === id)?.revision ?? 1 });
    }
    assert.deepEqual(closes.map(message => message.isError), [true, true, true, true, false, false]);
    return fauxAssistantMessage('The linked work was archived.');
  });
  t.after(() => f.close());
  const role = await f.runtime.assistants.create({ workspace: f.workspace, name: 'Thread curator', instructions: 'Organize threads on request.',
    tools: ['list_threads', 'rename_thread', 'close_thread'] });
  const assistant = { id: role.id, revision: role.revision };
  const source = await f.runtime.create('Original discussion.', f.workspace, [], { chat: true, assistant });
  sourceId = source.id;
  sibling = (await f.runtime.create('Related work by the same assistant.', f.workspace, [], { chat: true, assistant })).id;
  await until(() => f.runtime.status(sibling), state => state.status === 'answered');
  const separate = await f.runtime.create('Unrelated discussion.', f.workspace, [], { chat: true });
  unrelated = separate.id;
  const opened = await f.runtime.startThread(source.id, { title: 'Finished work', message: taskMessage, requestId: 'settled' });
  settled = opened.id;
  const pending = await until(() => f.runtime.status(settled), state => state.status === 'awaiting_confirmation');
  await f.runtime.confirm(settled, pending.goal!.brief!.revision, pending.briefDigest!);
  const original = await until(() => f.runtime.status(settled), state => state.status === 'completed');
  waiting = (await f.runtime.startThread(source.id, { title: 'Still waiting', message: taskMessage, requestId: 'waiting' })).id;
  await until(() => f.runtime.status(waiting), state => state.status === 'awaiting_confirmation');
  paused = (await f.runtime.startThread(source.id, { title: 'Paused with a pending brief', message: taskMessage, requestId: 'paused' })).id;
  await until(() => f.runtime.status(paused), state => state.status === 'awaiting_confirmation');
  await f.runtime.pause(paused);
  await until(() => f.runtime.status(sourceId), state => state.status === 'answered');
  await f.runtime.followUp(sourceId, 'Rename this chat and close the finished linked work.', 'edit-threads');
  const managed = await until(() => f.runtime.status(sourceId), state => ['answered', 'failed'].includes(state.status) && state.submission?.requestId === 'user:edit-threads');
  assert(managed.messages.some(message => message.role === 'assistant' && message.content.some(part => part.type === 'text' && part.text === 'The linked work was archived.')),
    JSON.stringify(managed.messages.filter(message => message.role === 'toolResult').map(message => message.content)));
  assert.equal(managed.thread?.title, 'Evidence review');
  assert.equal(managed.goal, undefined);
  assert.equal((await f.runtime.status(waiting)).thread?.archivedAt, undefined);
  const unresolved = await f.runtime.status(paused);
  assert.equal(unresolved.status, 'paused');
  assert.equal(unresolved.goal?.phase, 'awaiting_confirmation');
  assert.equal(unresolved.thread?.archivedAt, undefined);
  assert.equal((await f.runtime.status(unrelated)).thread, undefined);
  assert.deepEqual((await f.runtime.list('archived')).map(item => item.id).sort(), [settled, sibling].sort());
  const archived = await f.runtime.status(settled);
  assert.equal(archived.goal?.candidate?.id, original.goal?.candidate?.id);
  assert.equal(archived.budget.totalTokens, original.budget.totalTokens);
  assert.equal(archived.submission?.id, original.submission?.id);
  assert(!Object.hasOwn(managed, 'threadEditReceipts'));
  assert(!Object.hasOwn(archived, 'threadEditReceipts'));
  assert(!(await f.runtime.list('archived')).some(item => Object.hasOwn(item, 'threadEditReceipts')));
  await f.runtime.editThread(settled, { revision: archived.thread!.revision, archived: false });
  assert((await f.runtime.list()).some(item => item.id === settled));
});

for (const action of ['rename', 'close']) {
  test(`SIGKILL after applying a chat thread ${action} replays its receipt without overwriting the owner's later change`, { timeout: recoveryTestTimeoutMs }, async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'kada-thread-edit-')));
    const fixture = new URL('./fixtures/thread-edit-recovery-worker.ts', import.meta.url);
    let worker = startRecoveryWorker(fixture, 'create', directory, action);
    try {
      const applied = await worker.ready();
      assert.equal(await worker.stop(), 'SIGKILL');
      worker = startRecoveryWorker(fixture, 'recover', directory, action);
      const result = await worker.complete();
      assert.deepEqual(result.receipt, applied.receipt);
      assert.equal(result.title, 'Owner retained title');
      assert.equal(result.archived, false);
      assert.equal(result.receiptCount, 1);
      assert.equal(result.finalRevision, Number(applied.revision) + 1);
    } finally { await worker.stop(); await rm(directory, { recursive: true, force: true, maxRetries: 5 }); }
  });
}
