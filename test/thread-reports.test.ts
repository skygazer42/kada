import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { LocalRuntime } from '../src/runtime.js';
import { hasTool, recoveryTestTimeoutMs, scriptedFixture, startRecoveryWorker, until } from './helpers.js';

const taskMessage = 'Review the synthetic record.';
const summary = 'Synthetic record verified: total 42.';
const brief = { outcome: taskMessage, deliverables: ['Text result'], inputs: [],
  criteria: [{ text: 'Report the verified total', method: 'inspect' }], scope: ['Synthetic record'], assumptions: [], questions: [] };
const tool = (name: string, input: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage(fauxToolCall(name, input), { stopReason: 'toolUse' });
const submit = () => tool('task_submit', { summary, artifacts: [], criteria: [{ id: 1, status: 'passed', evidence: summary }] });

test('a verified independent task resumes the original chat once with a text-only report', async t => {
  let replies = 0;
  const f = await scriptedFixture(context => {
    const input = context.messages.findLast(message => message.role === 'user')?.content;
    if (typeof input === 'string' && input.includes('INDEPENDENT_THREAD_REPORT')) {
      assert(input.includes(summary));
      const rejected = context.messages.findLast(message => message.role === 'toolResult' && message.toolName === 'task_prepare');
      if (!rejected) return tool('task_prepare', brief);
      assert(rejected.role === 'toolResult' && rejected.isError);
      replies++;
      return fauxAssistantMessage('The original chat received the verified total 42.');
    }
    if (hasTool(context, 'task_submit')) return submit();
    if (input === taskMessage) return tool('task_prepare', brief);
    return fauxAssistantMessage('Initial conversation.');
  });
  let runtime = f.runtime;
  t.after(async () => { await runtime.close(); await f.close(); });
  const parent = await runtime.create('Discuss the synthetic record.', f.workspace, [], { chat: true });
  await until(() => runtime.status(parent.id), status => status.status === 'answered');
  const request = { title: 'Record check', message: taskMessage, requestId: 'report-case', reportBack: true };
  const child = await runtime.startThread(parent.id, request);
  const prepared = await until(() => runtime.status(child.id), status => status.status === 'awaiting_confirmation');
  assert.equal(child.thread.reportBack, true);
  assert.deepEqual((await runtime.status(parent.id)).threadReports, []);
  assert.equal(replies, 0);
  await runtime.confirm(child.id, prepared.goal!.brief!.revision, prepared.briefDigest!);
  const result = await until(() => runtime.status(parent.id), status => status.threadReports.length === 1 && status.status === 'answered');
  assert.equal(result.threadReports[0]?.taskId, child.id);
  assert.equal(result.threadReports[0]?.summary, summary);
  assert.equal(result.threadReports[0]?.mode, 'resumed');
  assert.equal(result.goal, undefined);
  assert.equal(replies, 1);
  const other = await runtime.create('Other chat.', f.workspace, [], { chat: true });
  assert.deepEqual((await runtime.status(other.id)).threadReports, []);
  await runtime.close();
  runtime = new LocalRuntime(f.settings, { models: f.models });
  await runtime.recover();
  assert.equal((await runtime.startThread(parent.id, request)).id, child.id);
  await assert.rejects(runtime.startThread(parent.id, { ...request, reportBack: false }), /different request/i);
  assert.deepEqual((await runtime.status(parent.id)).threadReports, result.threadReports);
  assert.equal(replies, 1);
});

test('the report waits for the original turn and a new user message runs separately', async t => {
  const originalStarted = Promise.withResolvers<void>(), finishOriginal = Promise.withResolvers<void>();
  const reportStarted = Promise.withResolvers<void>(), finishReport = Promise.withResolvers<void>();
  const turns: string[] = [];
  const f = await scriptedFixture(async context => {
    const input = context.messages.findLast(message => message.role === 'user')?.content;
    if (hasTool(context, 'task_submit')) return submit();
    if (input === taskMessage) return tool('task_prepare', brief);
    if (input === 'Keep this turn busy.') {
      turns.push('original'); originalStarted.resolve();
      await finishOriginal.promise;
    } else if (typeof input === 'string' && input.includes('INDEPENDENT_THREAD_REPORT')) {
      turns.push('report'); reportStarted.resolve();
      await finishReport.promise;
    } else if (input === 'New user input.') turns.push('user');
    return fauxAssistantMessage('Turn answered.');
  });
  t.after(async () => { finishOriginal.resolve(); finishReport.resolve(); await f.close(); });
  const parent = await f.runtime.create('Keep this turn busy.', f.workspace, [], { chat: true });
  await originalStarted.promise;
  const child = await f.runtime.startThread(parent.id, { title: 'While busy', message: taskMessage, requestId: 'busy', reportBack: true });
  const prepared = await until(() => f.runtime.status(child.id), status => status.status === 'awaiting_confirmation');
  await f.runtime.confirm(child.id, prepared.goal!.brief!.revision, prepared.briefDigest!);
  await until(() => f.runtime.status(child.id), status => status.status === 'completed');
  assert.deepEqual((await f.runtime.status(parent.id)).threadReports, []);
  assert.deepEqual(turns, ['original']);
  finishOriginal.resolve();
  await reportStarted.promise;
  await f.runtime.followUp(parent.id, 'New user input.', 'new-real-input');
  finishReport.resolve();
  await until(() => f.runtime.status(parent.id), status => status.status === 'answered' && turns.includes('user'));
  assert.deepEqual(turns, ['original', 'report', 'user']);
  assert.equal((await f.runtime.status(parent.id)).threadReports.length, 1);
});

test('an unanswered question keeps its original identity while a result is recorded', async t => {
  let reportReplies = 0;
  const f = await scriptedFixture(context => {
    const input = context.messages.findLast(message => message.role === 'user')?.content;
    if (hasTool(context, 'task_submit')) return submit();
    if (input === taskMessage) return tool('task_prepare', brief);
    if (typeof input === 'string' && input.includes('INDEPENDENT_THREAD_REPORT')) reportReplies++;
    if (input === 'Ask a question.' && !context.messages.some(message => message.role === 'toolResult')) {
      return tool('ask_user', { question: 'Which synthetic record?', options: ['First', 'Second'] });
    }
    return fauxAssistantMessage('Ready when you choose.');
  });
  t.after(() => f.close());
  const parent = await f.runtime.create('Ask a question.', f.workspace, [], { chat: true });
  const waiting = await until(() => f.runtime.status(parent.id), status => status.status === 'waiting_user');
  const child = await f.runtime.startThread(parent.id, { title: 'While waiting', message: taskMessage, requestId: 'waiting', reportBack: true });
  const prepared = await until(() => f.runtime.status(child.id), status => status.status === 'awaiting_confirmation');
  await f.runtime.confirm(child.id, prepared.goal!.brief!.revision, prepared.briefDigest!);
  const reported = await until(() => f.runtime.status(parent.id), status => status.threadReports.length === 1);
  assert.equal(reported.threadReports[0]?.mode, 'recorded');
  assert.equal(reported.status, 'waiting_user');
  assert.equal(reported.userQuestion?.id, waiting.userQuestion?.id);
  assert.equal(reported.budget.totalTokens, waiting.budget.totalTokens);
  assert.equal(reportReplies, 0);
});

for (const boundary of ['saved', 'admitted']) {
  test(`SIGKILL with an independent report ${boundary} preserves one source receipt`, { timeout: recoveryTestTimeoutMs }, async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'kada-thread-report-')));
    const fixture = new URL('./fixtures/thread-report-recovery-worker.ts', import.meta.url);
    let worker = startRecoveryWorker(fixture, 'create', directory, boundary);
    try {
      const initial = await worker.ready();
      assert.equal(await worker.stop(), 'SIGKILL');
      worker = startRecoveryWorker(fixture, 'recover', directory, boundary);
      const result = await worker.complete();
      assert.equal(result.id, initial.id);
      assert.equal(result.parent, initial.parent);
      assert.equal(result.summary, 'Original verified result 42.');
      assert.equal(result.mode, 'resumed');
      assert.equal(result.replies, 'report\n');
      assert.equal(result.reports, 1);
      assert.equal(result.childStatus, 'completed');
      if (boundary === 'admitted') assert.equal(result.submissionId, initial.submissionId);
    } finally { await worker.stop(); await rm(directory, { recursive: true, force: true, maxRetries: 5 }); }
  });
}
