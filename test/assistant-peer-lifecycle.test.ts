import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { fauxAssistantMessage, fauxToolCall, fauxProvider, Type } from '@earendil-works/pi-ai';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { defineExtension, defineTool, GenerationTask, hook, ROOT_CONVERSATION_ID, ToolTask, UsageDoc, type ConversationId } from '@earendil-works/pi-durable';
import { LocalRuntime } from '../src/runtime.js';
import { scriptedFixture, until } from './helpers.js';

const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' });

test('an early Goal submission yields to its already queued assistant report', { timeout: 15_000 }, async t => {
  const id = randomUUID();
  let runtime: LocalRuntime, collaborator: { id: string; revision: number }, prematureRetries = 0;
  const f = await scriptedFixture(async transcript => {
    const input = transcript.messages.filter(message => message.role === 'user').at(-1);
    if (input?.role === 'user' && String(input.content).startsWith('ASSISTANT_REPORT ')) {
      return call('task_submit', { summary: 'The original report has arrived.', artifacts: [] });
    }
    const results = transcript.messages.filter(message => message.role === 'toolResult');
    if (!results.some(result => result.toolName === 'assistant_assign')) {
      return call('assistant_assign', { assistant: collaborator, instructions: 'Return the original evidence.' });
    }
    if (results.some(result => result.toolName === 'task_submit')) {
      prematureRetries++;
      return fauxAssistantMessage('The report is still waiting for this turn to end.');
    }
    await until(() => runtime.status(id), status => status.submission?.status === 'queued' &&
      !!status.submission.requestId?.startsWith('assistant-report:'), 5000);
    return call('task_submit', { summary: 'This candidate must not be saved.', artifacts: [] });
  });
  runtime = f.runtime;
  t.after(() => f.close());
  const model = { provider: 'test-peer-report', modelId: 'role' };
  const peer = fauxProvider({ provider: model.provider, models: [{ id: model.modelId }] });
  peer.setResponses([() => fauxAssistantMessage('Original evidence.')]);
  f.models.setProvider(peer.provider);
  const saved = await runtime.assistants.create({ workspace: f.workspace, name: 'Evidence peer', instructions: 'Return evidence once.',
    model, tools: ['read'] });
  collaborator = { id: saved.id, revision: saved.revision };
  await runtime.create('Submit only after reading the original report.', f.workspace, [], { id, collaborators: [collaborator] });
  const done = await until(() => runtime.status(id), state => state.status === 'completed');
  assert.equal(prematureRetries, 0);
  assert.deepEqual(done.goal?.events.filter(event => event.type === 'submitted').map(event => event.detail), ['The original report has arrived.']);
  assert.equal(done.messages.filter(message => message.role === 'user' && String(message.content).startsWith('ASSISTANT_REPORT ')).length, 1);
});

for (const action of ['revise', 'pause', 'cancel', 'deadline', 'tokens'] as const) {
  test(`collaborative Runtime retires live and queued work on ${action}, with original IDs and no late report`, { timeout: 30_000 }, async t => {
    let started = false, stopped = 0, queuedCalls = 0, authorized: { id: string; revision: number };
    const hold = defineTool({ name: 'held_effect', description: 'Wait for the test to stop this original operation.', parameters: Type.Object({}),
      execute: async (_args, _api, context) => {
        started = true;
        await new Promise<void>(resolve => {
          if (context.abortSignal?.aborted) resolve();
          else context.abortSignal?.addEventListener('abort', () => resolve(), { once: true });
        });
        stopped++;
        return { output: [] };
      },
    });
    const ext = defineExtension({ name: 'test_assigned_work_lifecycle', tools: [hold] });
    const f = await scriptedFixture(transcript => {
      const user = String(transcript.messages.filter(message => message.role === 'user').at(-1)?.content);
      if (user.startsWith('USER_REVISED') || user.startsWith('Resume the original objective')) return call('task_submit', { summary: 'The current goal is settled.', artifacts: [] });
      assert(!user.startsWith('ASSISTANT_REPORT '), `Received an obsolete report after ${action}`);
      const assignments = transcript.messages.filter(message => message.role === 'toolResult' && message.toolName === 'assistant_assign');
      if (assignments.length < 2) return call('assistant_assign', { assistant: authorized, instructions: assignments.length ? 'SECOND_QUEUED' : 'FIRST_LIVE' });
      return fauxAssistantMessage('Waiting for my assignments.');
    }, { maxDurationMs: action === 'deadline' ? 2500 : 30_000, maxTotalTokens: action === 'tokens' ? 32_000 : undefined }, () => [ext]);
    let runtime = f.runtime;
    t.after(async () => { await runtime.close(); await f.close(); });
    const model = { provider: 'test-peer-lifecycle', modelId: 'role' };
    const peer = fauxProvider({ provider: model.provider, models: [{ id: model.modelId }] });
    peer.setResponses(Array.from({ length: 8 }, () => transcript => {
      const user = transcript.messages.filter(message => message.role === 'user').at(-1)?.content;
      if (user !== 'FIRST_LIVE' || transcript.messages.some(message => message.role === 'toolResult')) { queuedCalls++; return fauxAssistantMessage('Late work must not execute.'); }
      return call('held_effect', {});
    }));
    f.models.setProvider(peer.provider);
    const { id, revision } = await runtime.assistants.create({ workspace: f.workspace, name: 'Wait for stop', instructions: 'Wait only within the original task.', tools: ['held_effect'], model });
    authorized = { id, revision };
    const meta = await runtime.create('Start the two original jobs.', f.workspace, [], { collaborators: [authorized] });
    const initial = await until(() => runtime.status(meta.id), status => started && status.assistantWork.length === 2, 5000);
    const expected = ['tokens', 'deadline'].includes(action) ? 'budget_limited' : action === 'revise' ? 'completed' : action === 'pause' ? 'paused' : 'cancelled';
    if (action === 'revise') await runtime.followUp(meta.id, 'USER_REVISED complete the changed deliverable.', 'revision-2');
    if (action === 'pause') await runtime.pause(meta.id);
    if (action === 'cancel') await runtime.cancel(meta.id);
    if (action === 'tokens') {
      assert(initial.budget.totalTokens < 32_000);
      // Record measured tool usage on the native peer conversation while its request is in flight.
      const live = runtime['active'].get(meta.id)!;
      await live.harness.commit(async tx => {
        const usage = await tx.doc(UsageDoc, initial.assistantWork[0]!.conversationId);
        usage.tools.held_effect = { input: 32_000, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 32_000,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
      }, context);
    }
    const result = await until(() => runtime.status(meta.id), status => status.status === expected, 8_000);
    assert.equal(stopped, 1); assert.equal(queuedCalls, 0);
    assert.equal(result.tasks.filter(item => initial.assistantWork.some(work => work.conversationId === item.record.conversationId)).length, 0);
    assert(result.assistantWork.every(work => work.stop?.confirmed));
    assert.deepEqual(result.assistantWork.map(work => work.id), initial.assistantWork.map(work => work.id));
    assert.equal(result.deadlineAt, initial.deadlineAt);
    if (action === 'tokens') assert.match(result.goal!.reason!, /token budget exhausted/);
    assert(!result.messages.some(message => message.role === 'user' && String(message.content).startsWith('ASSISTANT_REPORT ')));
    if (action !== 'revise') {
      await runtime.close(); runtime = new LocalRuntime(f.settings, { models: f.models, extensions: [ext] });
      await runtime.recover();
      const reopened = await runtime.status(meta.id);
      assert.equal(reopened.status, expected); assert.equal(reopened.deadlineAt, initial.deadlineAt);
      assert(reopened.assistantWork.every(work => work.stop?.confirmed));
      assert.equal(queuedCalls, 0);
    }
    if (action === 'pause') {
      await runtime.resume(meta.id);
      const done = await until(() => runtime.status(meta.id), status => status.status === 'completed');
      assert.equal(queuedCalls, 0);
      assert.deepEqual(done.assistantWork.map(work => work.id), initial.assistantWork.map(work => work.id));
      assert.equal(done.goal?.epoch, initial.goal!.epoch + 1);
    }
  });
}

for (const boundary of ['model request', 'tool execution']) {
  test('peer budget is checked at ' + boundary + ' before dispatching the original action', { timeout: 15_000 }, async t => {
    let runtime: LocalRuntime, role: { id: string; revision: number }, crossed = false, effects = 0, peerRequests = 0;
    const id = randomUUID();
    const limit = 32_000;
    const consumeRemaining = async (conversation: ConversationId) => {
      const active = runtime['active'].get(id)!;
      await active.harness.commit(async tx => {
        const usage = await tx.doc(UsageDoc, conversation);
        usage.tools.fixture = { input: limit, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: limit,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
      }, context);
      crossed = true;
    };
    const effect = defineTool({
      name: 'record_once', description: 'Record a synthetic effect.', parameters: Type.Object({}), replay: 'safe',
      execute: async () => { effects++; return { output: [] }; },
    });
    const ext = defineExtension({ name: 'test_peer_budget_boundary', tools: [effect], hooks: [
      hook(GenerationTask, { async beforeRequest(_request, api) {
        if (boundary === 'model request' && api.conversationId !== ROOT_CONVERSATION_ID && !crossed) await consumeRemaining(api.conversationId);
      } }),
      hook(ToolTask, { async beforeTool(tool, api) {
        if (boundary === 'tool execution' && tool.name === effect.name && !crossed) await consumeRemaining(api.conversationId);
      } }),
    ] });
    const f = await scriptedFixture(transcript => {
      if (!transcript.messages.some(message => message.role === 'toolResult' && message.toolName === 'assistant_assign')) {
        return call('assistant_assign', { assistant: role, instructions: 'Record the original synthetic effect.' });
      }
      return fauxAssistantMessage('Wait for the assistant result.');
    }, { maxTotalTokens: limit }, () => [ext]);
    runtime = f.runtime;
    t.after(() => f.close());
    const selected = { provider: 'test-peer-budget', modelId: 'role' };
    const provider = fauxProvider({ provider: selected.provider, models: [{ id: selected.modelId }] });
    provider.setResponses(Array.from({ length: 3 }, () => () => {
      peerRequests++;
      return call('record_once', {});
    }));
    f.models.setProvider(provider.provider);
    const saved = await runtime.assistants.create({ workspace: f.workspace, name: 'Budget peer', instructions: 'Record one synthetic effect.',
      tools: ['record_once'], model: selected });
    role = { id: saved.id, revision: saved.revision };
    // Keep the host supervisor out of the race until the Pi request guard has run.
    const supervise = runtime['supervise'].bind(runtime);
    runtime['supervise'] = async () => {};
    await runtime.create('Check the work budget at the request boundary.', f.workspace, [], { id, collaborators: [role] });
    const captured = await until(() => runtime.status(id), state => crossed && !!state.assistantWork[0]?.result);
    assert.equal(effects, 0);
    assert.equal(peerRequests, boundary === 'model request' ? 0 : 1);
    assert(captured.budget.totalTokens >= limit);
    runtime['supervise'] = supervise;
    assert.equal((await until(() => runtime.status(id), state => state.status === 'budget_limited')).assistantWork[0]?.stop?.confirmed, true);
  });
}
