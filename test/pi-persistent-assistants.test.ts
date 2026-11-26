import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, Type, type TranscriptContext } from '@earendil-works/pi-ai';
import { AssistantEntry, configure, createRegistry, defineDoc, defineExtension, defineTask, defineTool, Harness, hook, section, ToolTask, UsageDoc,
  type ConversationId, type EntryId, type TaskId } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { taskUsage } from '../src/budget.js';
import { until } from './helpers.js';

// Pi v1.4.0 official example 23: background anchor + native durable delivery/report phases.
const Peers = defineDoc<{ conversation?: ConversationId; deliveries: Record<string, TaskId>; reported: EntryId[] }>({
  kind: 'test.persistent_peers', version: 1, scope: 'conversation', history: 'latest', fork: 'initial',
  initial: () => ({ deliveries: {}, reported: [] }), checkpointWhen: () => true,
});
const Anchor = defineTask<null, { phase: 'done' }, null>({ name: 'test.peer_anchor', version: 1, initial: () => ({ phase: 'done' }),
  phases: { done: (_task, runtime, context) => runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: null } }), context) },
  abort: (_task, runtime, context) => runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context),
});
type DeliveryState = { phase: 'deliver' } | { phase: 'report'; text?: string };
const Delivery = defineTask<{ peer: ConversationId; text: string }, DeliveryState, null>({
  name: 'test.peer_delivery', version: 1, initial: () => ({ phase: 'deliver' }),
  phases: {
    deliver: async (task, runtime, context) => {
      const peer = await runtime.conversation(task.input.peer, context); assert(peer);
      const submission = await peer.submit({ type: 'input', content: task.input.text, requestId: 'peer-message:' + task.id, whenBusy: 'followUp' }, context);
      const settled = await submission.wait(context);
      await runtime.commit(async tx => {
        if (settled.status !== 'done' || settled.type !== 'input') return { status: 'running', checkpoint: { phase: 'report' } };
        const state = await tx.doc(Peers, runtime.conversationId);
        if (state.reported.includes(settled.answer)) return { status: 'running', checkpoint: { phase: 'report' } };
        state.reported.push(settled.answer);
        const entry = await tx.entry(AssistantEntry, settled.answer), answer = entry?.model?.[0];
        const text = answer?.role === 'assistant' ? answer.content.filter(part => part.type === 'text').map(part => part.text).join('') : '';
        return { status: 'running', checkpoint: { phase: 'report', text } };
      }, context);
    },
    report: async (task, runtime, context) => {
      const text = task.state.checkpoint.text;
      if (text !== undefined) {
        const main = await runtime.conversation(runtime.conversationId, context); assert(main);
        await main.submit({ type: 'input', content: 'PEER_REPORT ' + text, requestId: 'peer-report:' + task.id, whenBusy: 'followUp' }, context);
      }
      await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: null } }), context);
    },
  },
  abort: (_task, runtime, context) => runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context),
});

function peerTools(extra: ReturnType<typeof defineExtension>[] = []) {
  const send = defineTool({ name: 'peer_send', description: 'Native persistent peer probe.', parameters: Type.Object({ text: Type.String() }), replay: 'safe',
    execute: async (args, api, context) => {
      const saved = await api.commit(async tx => {
        const state = await tx.doc(Peers, api.conversationId), key = String(api.taskId);
        if (state.deliveries[key]) return { peer: state.conversation!, delivery: state.deliveries[key]! };
        if (!state.conversation) {
          const anchor = await tx.createTask(Anchor, null, { ownership: { kind: 'conversation' }, background: true });
          const child = await tx.createConversation({ ownership: { kind: 'task', taskId: anchor } });
          await configure(tx, child.id, { extensions: extra, tools: extra.flatMap(extension => extension.tools ?? []), instructions: 'NATIVE_STANDING_PEER_614' });
          state.conversation = child.id;
        }
        const delivery = await tx.createTask(Delivery, { peer: state.conversation, text: args.text }, { ownership: { kind: 'conversation' }, background: true });
        state.deliveries[key] = delivery; return { peer: state.conversation, delivery };
      }, context);
      return { output: [{ type: 'text', text: JSON.stringify(saved) }] };
    },
  });
  return defineExtension({ name: 'native_peer_probe', tools: [send], tasks: [Anchor, Delivery] });
}

async function fixture(t: test.TestContext, respond: (context: TranscriptContext) => ReturnType<typeof fauxAssistantMessage>, extra: ReturnType<typeof defineExtension>[] = []) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'kada-pi-peers-'))), models = createModels();
  const ref = { provider: 'pi-persistent-peer', modelId: 'scripted' }, provider = fauxProvider({ provider: ref.provider, models: [{ id: ref.modelId }] });
  provider.setResponses(Array.from({ length: 30 }, () => respond)); models.setProvider(provider.provider);
  const registry = createRegistry(), extension = peerTools(extra);
  for (const item of [extension, ...extra]) registry.install(item);
  const open = async () => {
    const storage = await openNodeSqliteStorage(join(directory, 'session.sqlite'));
    const harness = await Harness.open(storage, { models, registry }, ctx);
    const root = await harness.root(ctx, { agent: { model: ref, extensions: [extension] } });
    return { harness, root, storage };
  };
  let current = await open();
  t.after(async () => { await current.harness.close(ctx); await rm(directory, { recursive: true, force: true, maxRetries: 5 }); });
  return { get harness() { return current.harness; }, get root() { return current.root; }, get storage() { return current.storage; },
    reopen: async () => { await current.harness.close(ctx); current = await open(); } };
}

const peerContext = (context: TranscriptContext) => JSON.stringify(context.messages.filter(message => message.role === 'system')).includes('NATIVE_STANDING_PEER_614');
test('Pi native persistent peer reuses its transcript after reopening and reports each original message once', async t => {
  let peerCalls = 0;
  const f = await fixture(t, context => {
    if (peerContext(context)) {
      peerCalls++;
      if (peerCalls === 2) assert(context.messages.some(message => message.role === 'user' && message.content === 'Remember PEER_CODE_814.'));
      return fauxAssistantMessage('PEER_CODE_814');
    }
    const last = context.messages.filter(message => message.role === 'user' || message.role === 'toolResult').at(-1)!;
    if (last.role === 'user' && last.content === 'FIRST') return fauxAssistantMessage(fauxToolCall('peer_send', { text: 'Remember PEER_CODE_814.' }), { stopReason: 'toolUse' });
    if (last.role === 'user' && last.content === 'SECOND') return fauxAssistantMessage(fauxToolCall('peer_send', { text: 'Recall the original code.' }), { stopReason: 'toolUse' });
    return fauxAssistantMessage('Noted.');
  });
  const send = async (content: string) => {
    const submission = await f.root.submit({ type: 'input', content, requestId: content }, ctx); assert.equal((await submission.wait(ctx)).status, 'done');
    const state = await f.harness.snapshot(Peers, f.root.id, ctx); assert(state?.conversation);
    for (const id of Object.values(state.deliveries)) await f.harness.waitForTask(id, ctx);
    await f.root.waitForIdle(ctx); return state;
  };
  const first = await send('FIRST'); assert.equal(peerCalls, 1);
  await f.reopen(); assert.equal(peerCalls, 1, 'reopening idle native peers must not call the model');
  const second = await send('SECOND'); assert.equal(second.conversation, first.conversation); assert.equal(peerCalls, 2);
  const peer = await f.harness.conversation(second.conversation!, ctx); assert(peer);
  const requests = await f.storage.scanSubmissions({ conversationId: peer.id }, 100, undefined, ctx);
  assert.equal(requests.items.length, 2); assert.equal(new Set(requests.items.map(item => item.requestId)).size, 2);
  const mainMessages = (await f.root.context(ctx)).messages;
  assert.equal(mainMessages.filter(message => message.role === 'user' && String(message.content).startsWith('PEER_REPORT ')).length, 2);
  const before = taskUsage(await f.harness.usage(ctx));
  const retry = await f.root.submit({ type: 'input', content: 'SECOND', requestId: 'SECOND' }, ctx); assert.equal((await retry.wait(ctx)).status, 'done');
  assert.equal(peerCalls, 2); assert.deepEqual(taskUsage(await f.harness.usage(ctx)), before);
  const own = await f.harness.snapshot(UsageDoc, f.root.id, ctx), child = await f.harness.snapshot(UsageDoc, peer.id, ctx);
  assert(taskUsage(child!).totalTokens > 0, 'the native usage comparison must include real synthetic peer usage');
  assert.equal(before.totalTokens, taskUsage(own!).totalTokens + taskUsage(child!).totalTokens);
});

test('Pi native background boundary skips peer work for ordinary abort and stops it for a full subtree abort', async t => {
  const started = Promise.withResolvers<void>(), stopped = Promise.withResolvers<void>(); let aborted = false;
  const hold = defineTool({ name: 'hold', description: 'Wait for native cancellation.', parameters: Type.Object({}), replay: 'safe', execute: async (_args, _api, context) => {
    const signal = context.abortSignal; assert(signal);
    started.resolve(); await new Promise<void>(resolve => signal.addEventListener('abort', () => { aborted = true; stopped.resolve(); resolve(); }, { once: true }));
    return { output: [] };
  } });
  const f = await fixture(t, context => peerContext(context) ? fauxAssistantMessage(fauxToolCall('hold', {}), { stopReason: 'toolUse' }) :
    context.messages.some(message => message.role === 'toolResult' && message.toolName === 'peer_send') ? fauxAssistantMessage('Peer working independently.') :
      fauxAssistantMessage(fauxToolCall('peer_send', { text: 'Wait for the stop signal.' }), { stopReason: 'toolUse' }),
    [defineExtension({ name: 'native_peer_hold', tools: [hold] })]);
  const first = await f.root.submit({ type: 'input', content: 'Start peer.' }, ctx); assert.equal((await first.wait(ctx)).status, 'done'); await started.promise;
  await f.root.abort(ctx); assert.equal(aborted, false);
  await f.root.abort(ctx, { background: true }); await stopped.promise; assert.equal(aborted, true);
  const state = await f.harness.snapshot(Peers, f.root.id, ctx); assert(state?.conversation);
  const peer = await f.harness.conversation(state.conversation, ctx); assert(peer); await peer.waitForIdle(ctx);
  assert(!(await f.root.context(ctx)).messages.some(message => message.role === 'user' && String(message.content).startsWith('PEER_REPORT ')));
  await until(async () => (await f.harness.inspect(ctx)).tasks.length, count => count === 0);
});

test('Pi native peer queues a second assignment after the current answer and returns both distinct receipts', async t => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const hold = defineTool({ name: 'hold', description: 'Hold the first native assignment.', parameters: Type.Object({}), replay: 'safe', execute: async () => {
    entered.resolve(); await release.promise; return { output: [{ type: 'text', text: 'Released first assignment.' }] };
  } });
  t.after(() => release.resolve());
  const f = await fixture(t, context => {
    const lastUser = context.messages.filter(message => message.role === 'user').at(-1)?.content;
    if (peerContext(context)) {
      if (lastUser === 'FIRST_JOB' && !context.messages.some(message => message.role === 'toolResult' && message.toolName === 'hold')) return fauxAssistantMessage(fauxToolCall('hold', {}), { stopReason: 'toolUse' });
      if (lastUser === 'FIRST_JOB') return fauxAssistantMessage('FIRST_RESULT');
      assert.equal(lastUser, 'SECOND_JOB');
      assert(context.messages.some(message => message.role === 'assistant' && message.content.some(part => part.type === 'text' && part.text === 'FIRST_RESULT')));
      return fauxAssistantMessage('SECOND_RESULT');
    }
    const last = context.messages.filter(message => message.role === 'user' || message.role === 'toolResult').at(-1)!;
    if (last.role === 'user' && (last.content === 'QUEUE_FIRST' || last.content === 'QUEUE_SECOND')) return fauxAssistantMessage(fauxToolCall('peer_send', {
      text: last.content === 'QUEUE_FIRST' ? 'FIRST_JOB' : 'SECOND_JOB',
    }), { stopReason: 'toolUse' });
    return fauxAssistantMessage('Queue state noted.');
  }, [defineExtension({ name: 'native_peer_queue_hold', tools: [hold] })]);
  assert.equal((await (await f.root.submit({ type: 'input', content: 'QUEUE_FIRST', requestId: 'first' }, ctx)).wait(ctx)).status, 'done');
  await entered.promise;
  assert.equal((await (await f.root.submit({ type: 'input', content: 'QUEUE_SECOND', requestId: 'second' }, ctx)).wait(ctx)).status, 'done');
  const state = await f.harness.snapshot(Peers, f.root.id, ctx); assert(state?.conversation);
  const queued = await until(() => f.storage.scanSubmissions({ conversationId: state.conversation! }, 100, undefined, ctx), page => page.items.length === 2);
  assert.deepEqual(queued.items.map(item => item.status).sort(), ['placed', 'queued']);
  release.resolve();
  for (const id of Object.values(state.deliveries)) await f.harness.waitForTask(id, ctx);
  await f.root.waitForIdle(ctx);
  const settled = await f.storage.scanSubmissions({ conversationId: state.conversation }, 100, undefined, ctx);
  assert(settled.items.every(item => item.status === 'done'));
  assert.equal(new Set(settled.items.filter(item => item.status === 'done' && item.type === 'input').map(item => item.answer)).size, 2);
  const reports = (await f.root.context(ctx)).messages.filter(message => message.role === 'user' && String(message.content).startsWith('PEER_REPORT '));
  assert.deepEqual(reports.map(message => message.content).sort(), ['PEER_REPORT FIRST_RESULT', 'PEER_REPORT SECOND_RESULT']);
});

test('one Pi registry resolves different peer role pins from their own committed conversation documents after restart', async t => {
  const Role = defineDoc<{ label: string; write: boolean }>({ kind: 'test.peer_role_pin', version: 1, scope: 'conversation', history: 'latest', fork: 'initial',
    initial: () => ({ label: '', write: false }), checkpointWhen: () => true });
  let effects = 0;
  const write = defineTool({ name: 'write', description: 'Synthetic scoped action.', parameters: Type.Object({}), execute: async () => {
    effects++; return { output: [{ type: 'text', text: 'Synthetic write happened.' }] };
  } });
  const policy = defineExtension({ name: 'native_peer_role_policy', tasks: [Anchor], tools: [write],
    sections: [section('peer_role', async (input, context) => (await input.read.snapshot(Role, input.conversationId, context))?.label)],
    hooks: [hook(ToolTask, { async beforeTool(call, api, context) {
      const role = await api.snapshot(Role, api.conversationId, context);
      if (call.name === 'write' && !role?.write) return { block: 'This peer has no write permission.' };
    } })],
  });
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'kada-pi-peer-role-'))), models = createModels();
  const model = { provider: 'native-peer-roles', modelId: 'scripted' }, provider = fauxProvider({ provider: model.provider, models: [{ id: model.modelId }] });
  provider.setResponses(Array.from({ length: 16 }, () => context => {
    const system = JSON.stringify(context.messages.filter(message => message.role === 'system')), reader = system.includes('PEER_READER_PIN_784');
    assert.equal(system.includes('PEER_WRITER_PIN_915'), !reader);
    const lastInput = context.messages.findLastIndex(message => message.role === 'user');
    const result = context.messages.slice(lastInput + 1).find(message => message.role === 'toolResult');
    if (!result) return fauxAssistantMessage(fauxToolCall('write', {}), { stopReason: 'toolUse' });
    assert.equal(result.isError, reader); return fauxAssistantMessage('Own role resolved.');
  }));
  models.setProvider(provider.provider); const registry = createRegistry(); registry.install(policy);
  const open = () => openNodeSqliteStorage(join(directory, 'session.sqlite')).then(storage => Harness.open(storage, { models, registry }, ctx));
  let harness = await open();
  t.after(async () => { await harness.close(ctx); await rm(directory, { recursive: true, force: true, maxRetries: 5 }); });
  const root = await harness.root(ctx, { agent: { model } });
  const peers = await harness.commit(async tx => {
    const ids: ConversationId[] = [];
    for (const [label, allowed] of [['PEER_READER_PIN_784', false], ['PEER_WRITER_PIN_915', true]] as const) {
      const anchor = await tx.createTask(Anchor, null, { conversationId: root.id, ownership: { kind: 'conversation' }, background: true });
      const peer = await tx.createConversation({ ownership: { kind: 'task', taskId: anchor } });
      Object.assign(await tx.doc(Role, peer.id), { label, write: allowed });
      await configure(tx, peer.id, { model, extensions: [policy], tools: [write] }); ids.push(peer.id);
    }
    return ids;
  }, ctx);
  for (const requestId of ['first', 'after-reopen']) {
    if (requestId === 'after-reopen') { await harness.close(ctx); harness = await open(); }
    await Promise.all(peers.map(async id => {
      const peer = await harness.conversation(id, ctx); assert(peer);
      assert.equal((await (await peer.submit({ type: 'input', content: 'Resolve your own pin.', requestId }, ctx)).wait(ctx)).status, 'done');
    }));
    assert.equal(effects, requestId === 'first' ? 1 : 2, 'only the writer peer may produce the synthetic effect');
  }
});
