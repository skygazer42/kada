import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { createRegistry, defineTask, defineExtension, Harness, MemoryStorage, type Tx, type ConversationId } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { GoalDoc, goalExtension } from '../src/goal.js';
import type { AssistantPin } from '../src/assistants.js';
import { AssistantPeers, claimAssistantWork, captureAssistantResult, assistantWorkView, outstandingAssistantWork, requestAssistantStop, confirmAssistantStop,
  type AssistantWorkIntent, type AssistantAdmission, type AssistantSeat } from '../src/assistant-peer-state.js';

const Dummy = defineTask<null, { phase: 'done' }, null>({ name: 'test.peer_state_native_task', version: 1, initial: () => ({ phase: 'done' }),
  phases: { done: (_task, runtime, context) => runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: null } }), context) },
  abort: (_task, runtime, context) => runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context),
});
const pin = (id: string): AssistantPin => ({ id, revision: 1, project: process.cwd(), name: 'Peer ' + id, description: '', instructions: 'PRIVATE_PEER_INSTRUCTIONS_529',
  model: { provider: 'peer-state', modelId: 'scripted' }, tools: ['read'] });
const admission = (root: ConversationId, source = root, parentId?: string): AssistantAdmission => ({ root, source, project: process.cwd(), enabled: true,
  now: 100, deadlineAt: 10_000, requiresConfirmation: true, goal: { initialized: true, phase: 'working', revision: 1, epoch: 1, confirmation: {} },
  maxPeers: 2, maxWorks: 8, maxDepth: 4, tools: ['read', 'write'], ...(parentId ? { parentId } : {}) });
const allocateNative = (tx: Tx, source: ConversationId) => async (seat: AssistantSeat | undefined) => {
  const anchor = seat?.anchor ?? await tx.createTask(Dummy, null, { conversationId: source, ownership: { kind: 'conversation' }, background: true });
  const conversation = seat ? await tx.conversation(seat.conversationId) : await tx.createConversation({ ownership: { kind: 'task', taskId: anchor } }); assert(conversation);
  const taskId = await tx.createTask(Dummy, null, { conversationId: source, ownership: { kind: 'conversation' }, background: true });
  return { conversation, anchor, taskId };
};

async function fixture(t: test.TestContext, goalTools = false) {
  const models = createModels(), provider = fauxProvider({ provider: 'peer-state', models: [{ id: 'scripted' }] });
  provider.setResponses(Array.from({ length: 30 }, () => fauxAssistantMessage('Original native answer.'))); models.setProvider(provider.provider);
  const registry = createRegistry(); registry.install(defineExtension({ name: 'native_state_probe', tasks: [Dummy] }));
  if (goalTools) registry.install(goalExtension({ assistantPeers: true }));
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, ctx), root = await harness.root(ctx, { agent: { model: pin('reader').model } });
  t.after(() => harness.close(ctx));
  const authority = (source = root.id, parentId?: string) => admission(root.id, source, parentId);
  const create = (tx: Tx, source = root.id) => allocateNative(tx, source);
  const intent = (requestId: string, target = pin('reader')): AssistantWorkIntent => ({ requestId, assistant: target, instructions: 'Read the original evidence.', tools: ['read'], mode: 'standing', files: [] });
  const claim = (input: AssistantWorkIntent, auth = authority()) => harness.commit(tx => claimAssistantWork(tx, auth, input, create(tx, auth.source)), ctx);
  return { harness, root, authority, create, intent, claim, provider, registry };
}

test('peer work atomically pins its native task and role, replays its original identity and reuses only compatible standing seats', async t => {
  const f = await fixture(t), input = f.intent('original');
  const [first, retry] = await Promise.all([f.claim(input), f.claim(input)]);
  assert.deepEqual(retry, first); assert(first.taskId); assert(first.target);
  input.assistant.instructions = 'Later caller mutation'; input.tools.push('write');
  const state = await f.harness.snapshot(AssistantPeers, ctx); assert(state);
  assert.equal(state.seats[String(first.target)]!.pin.instructions, 'PRIVATE_PEER_INSTRUCTIONS_529');
  assert.deepEqual(state.seats[String(first.target)]!.tools, ['read']);
  const second = await f.claim(f.intent('second'));
  assert.equal(second.target, first.target); assert.notEqual(second.taskId, first.taskId);
  const revised = await f.claim(f.intent('new-revision', { ...pin('reader'), revision: 2 }));
  assert.notEqual(revised.target, first.target);
  await assert.rejects(f.claim({ ...f.intent('original'), instructions: 'Changed original request' }), { status: 409 });
  const summary = assistantWorkView(state, first.id);
  assert.doesNotMatch(JSON.stringify(summary), /PRIVATE_PEER|fingerprint|instructions/);
  assert.equal(summary?.assistant.id, 'reader'); assert.equal(summary?.assistant.revision, 1);
});

test('failed native allocation rolls back peer business identity and ownership in the same Pi transaction', async t => {
  const f = await fixture(t), before = await f.harness.commit(tx => tx.scanConversations({}, 100), ctx);
  const tasks = await f.harness.commit(tx => tx.scanTasks({}, 100), ctx);
  await assert.rejects(f.harness.commit(tx => claimAssistantWork(tx, f.authority(), f.intent('rollback'), async seat => {
    await f.create(tx)(seat); throw new Error('Native allocation failed.');
  }), ctx), /Native allocation failed/);
  assert.equal((await f.harness.commit(tx => tx.scanConversations({}, 100), ctx)).items.length, before.items.length);
  assert.equal((await f.harness.commit(tx => tx.scanTasks({}, 100), ctx)).items.length, tasks.items.length);
  assert.equal((await f.harness.snapshot(AssistantPeers, ctx))?.work.rollback, undefined);
});

test('peer admission rejects inactive, expired, unconfirmed and foreign sources without native allocation', async t => {
  const f = await fixture(t);
  const noCreate = async () => assert.fail('Refused work must not allocate a native task.');
  for (const change of [{ enabled: false }, { deadlineAt: 100 }, { goal: { ...f.authority().goal, phase: 'submitted' } },
    { goal: { ...f.authority().goal, confirmation: undefined } }, { source: 999 as ConversationId }, { maxPeers: 0 }]) {
    await assert.rejects(f.harness.commit(tx => claimAssistantWork(tx, { ...f.authority(), ...change }, f.intent('refused'), noCreate), ctx));
  }
  await assert.rejects(f.harness.commit(tx => claimAssistantWork(tx, f.authority(), f.intent('foreign', { ...pin('reader'), project: join(process.cwd(), 'foreign') }), noCreate), ctx), { status: 404 });
  assert.equal((await f.harness.snapshot(AssistantPeers, ctx))?.work.refused, undefined);
});

test('nested work keeps the original lineage and cannot send to itself or an ancestor', async t => {
  const f = await fixture(t), reader = await f.claim(f.intent('reader'));
  const writer = await f.claim(f.intent('writer', pin('writer')), f.authority(reader.target, reader.id));
  assert.deepEqual(writer.lineage, ['reader', 'writer']); assert.equal(writer.parentId, reader.id);
  const noCreate = async () => assert.fail('A loop must not allocate.');
  await assert.rejects(f.harness.commit(tx => claimAssistantWork(tx, f.authority(reader.target, reader.id), f.intent('self'), noCreate), ctx), /itself|ancestor/);
  await assert.rejects(f.harness.commit(tx => claimAssistantWork(tx, f.authority(writer.target, writer.id), f.intent('cycle'), noCreate), ctx), /itself|ancestor/);
  await assert.rejects(f.harness.commit(tx => claimAssistantWork(tx, { ...f.authority(writer.target, writer.id), maxDepth: 2 }, f.intent('deep', pin('third')), noCreate), ctx), /depth/);
  const state = await f.harness.snapshot(AssistantPeers, ctx); assert(state);
  assert(state.work.reader!.inputRequests.includes(writer.reportRequestId), 'parent work must await its nested report, not its first acknowledgment');
});

test('work completion is derived from the exact native submissions and required report receipt', async t => {
  const f = await fixture(t), work = await f.claim(f.intent('read'));
  assert.equal(await f.harness.commit(tx => outstandingAssistantWork(tx, f.root.id, f.authority().goal), ctx), true);
  assert.equal(await f.harness.commit(tx => captureAssistantResult(tx, work.id), ctx), undefined);
  const target = await f.harness.conversation(work.target, ctx); assert(target);
  await (await target.submit({ type: 'input', content: 'Read evidence.', requestId: work.messageRequestId }, ctx)).wait(ctx);
  const result = await f.harness.commit(tx => captureAssistantResult(tx, work.id), ctx);
  assert.equal(result?.status, 'done'); assert(result?.answer);
  assert.equal(await f.harness.commit(tx => outstandingAssistantWork(tx, f.root.id, f.authority().goal), ctx), true, 'an unreported result is still pending');
  await (await f.root.submit({ type: 'input', content: 'Report original work.', requestId: work.reportRequestId }, ctx)).wait(ctx);
  assert.equal(await f.harness.commit(tx => outstandingAssistantWork(tx, f.root.id, f.authority().goal), ctx), false);
  assert.equal(await f.harness.commit(tx => outstandingAssistantWork(tx, f.root.id, { ...f.authority().goal, epoch: 2 }), ctx), false);
});

test('stopping records an original version, waits for native confirmation and fences automatic re-dispatch in the source task', async t => {
  const f = await fixture(t), work = await f.claim(f.intent('stop-me'));
  const shown = await f.harness.commit(async tx => assistantWorkView(await tx.doc(AssistantPeers), work.id), ctx); assert(shown);
  await assert.rejects(f.harness.commit(tx => requestAssistantStop(tx, f.root.id, work.id, 'wrong-version', 'owner-stop', 200), ctx), { status: 409 });
  const requested = await f.harness.commit(tx => requestAssistantStop(tx, f.root.id, work.id, shown.controlVersion, 'owner-stop', 200), ctx);
  assert.equal(requested.stop?.confirmed, false);
  assert.equal(await f.harness.commit(tx => outstandingAssistantWork(tx, f.root.id, f.authority().goal), ctx), true);
  await f.harness.waitForTask(work.taskId, ctx);
  await f.harness.commit(tx => confirmAssistantStop(tx, work.id, 'owner-stop'), ctx);
  assert.equal(await f.harness.commit(tx => outstandingAssistantWork(tx, f.root.id, f.authority().goal), ctx), false);
  await assert.rejects(f.claim(f.intent('retry-stop')), /stopped/);
  await assert.rejects(f.claim(f.intent('resume-must-not-clear-stop'), { ...f.authority(), goal: { ...f.authority().goal, epoch: 2 } }), /stopped/);
  await assert.rejects(f.claim(f.intent('revision-must-not-clear-stop'), { ...f.authority(), goal: { ...f.authority().goal, revision: 2 } }), /stopped/);
  const replay = await f.claim(f.intent('stop-me'));
  assert.equal(replay.id, work.id); assert.equal(replay.taskId, work.taskId);
  assert.equal((await f.harness.snapshot(AssistantPeers, ctx))?.work[work.id]?.stop?.confirmed, true, 'original request replay must not clear a later stop');
});

test('Goal submission checks outstanding peer work in its original transaction when the feature is enabled', async t => {
  const f = await fixture(t, true); const work = await f.claim(f.intent('pending'));
  const state = await f.harness.snapshot(AssistantPeers, ctx); assert(state?.work[work.id]);
  await f.harness.commit(async tx => { Object.assign(await tx.doc(GoalDoc), { initialized: true, objective: 'Original Goal', phase: 'working' }); }, ctx);
  f.provider.setResponses(Array.from({ length: 3 }, () => context => context.messages.some(message => message.role === 'toolResult')
    ? fauxAssistantMessage('Waiting for the original peer work.') : fauxAssistantMessage(fauxToolCall('task_submit', { summary: 'Too early', artifacts: [] }), { stopReason: 'toolUse' })));
  await (await f.root.submit({ type: 'input', content: 'Submit the original result.' }, ctx)).wait(ctx);
  const status = await f.harness.snapshot(GoalDoc, ctx); assert.equal(status?.phase, 'working'); assert.equal(status?.candidate, null);
  assert((await f.root.context(ctx)).messages.some(message => message.role === 'toolResult' && message.toolName === 'task_submit' && message.isError));
});

test('concurrent native admission and Goal submission cannot both succeed against the same Goal transaction', async t => {
  for (const submitFirst of [false, true]) {
    const f = await fixture(t);
    await f.harness.commit(async tx => Object.assign(await tx.doc(GoalDoc), { initialized: true, phase: 'working' }), ctx);
    const claim = () => f.harness.commit(async tx => claimAssistantWork(tx, { ...f.authority(), requiresConfirmation: false, goal: await tx.doc(GoalDoc) }, f.intent('race'), f.create(tx)), ctx);
    const submit = () => f.harness.commit(async tx => {
      const goal = await tx.doc(GoalDoc);
      if (await outstandingAssistantWork(tx, f.root.id, goal)) throw new Error('Assistant work pending.');
      goal.phase = 'submitted';
    }, ctx);
    const results = await Promise.allSettled(submitFirst ? [submit(), claim()] : [claim(), submit()]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const state = await f.harness.snapshot(AssistantPeers, ctx), goal = await f.harness.snapshot(GoalDoc, ctx);
    assert.equal(Boolean(state?.work.race), !submitFirst); assert.equal(goal?.phase, submitFirst ? 'submitted' : 'working');
  }
});

test('peer ceilings bound concurrent native seats and total work without losing standing-seat reuse', async t => {
  const f = await fixture(t), first = await f.claim(f.intent('first'));
  await f.claim(f.intent('second', pin('writer')));
  assert.equal((await f.claim(f.intent('queue-on-first'))).target, first.target);
  await assert.rejects(f.claim({ ...f.intent('extra-seat'), mode: 'new' }), /maximum active/);
  await assert.rejects(f.claim(f.intent('total-limit'), { ...f.authority(), maxWorks: 3 }), /work limit/);
  await assert.rejects(f.claim(f.intent('outside-source-tools'), { ...f.authority(), tools: [] }), /source scope/);
  await assert.rejects(f.claim({ ...f.intent('outside-role-tools'), tools: ['write'] }), { status: 400 });
  await assert.rejects(f.harness.commit(tx => claimAssistantWork(tx, { ...f.authority(), maxPeers: 4 }, { ...f.intent('overwrite-seat'), mode: 'new' }, async () => {
    const state = await tx.doc(AssistantPeers), seat = state.seats[String(first.target)]!;
    const conversation = await tx.conversation(first.target); assert(conversation);
    const taskId = await tx.createTask(Dummy, null, { conversationId: f.root.id, ownership: { kind: 'conversation' }, background: true });
    return { conversation, taskId, anchor: seat.anchor };
  }), ctx), /cannot overwrite/);
  assert.equal((await f.harness.snapshot(AssistantPeers, ctx))?.seats[String(first.target)]?.pin.revision, 1);
  await assert.rejects(f.claim(f.intent('epoch-cannot-reset-total'), { ...f.authority(), goal: { ...f.authority().goal, epoch: 2 }, maxWorks: 3 }), /work limit/);
  await assert.rejects(f.claim(f.intent('revision-cannot-reset-total'), { ...f.authority(), goal: { ...f.authority().goal, revision: 2 }, maxWorks: 3 }), /work limit/);
});

test('a stop cannot be confirmed while its exact native input is still placed', async t => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); t.after(() => release.resolve());
  const f = await fixture(t), work = await f.claim(f.intent('active'));
  f.provider.setResponses([async () => { entered.resolve(); await release.promise; return fauxAssistantMessage('Native input settled.'); }]);
  const peer = await f.harness.conversation(work.target, ctx); assert(peer);
  const input = await peer.submit({ type: 'input', content: 'Do original work.', requestId: work.messageRequestId }, ctx);
  const pending = input.wait(ctx); await entered.promise;
  const shown = assistantWorkView(await f.harness.snapshot(AssistantPeers, ctx), work.id); assert(shown);
  await f.harness.commit(tx => requestAssistantStop(tx, f.root.id, work.id, shown.controlVersion, 'stop-active', 200), ctx);
  await f.harness.waitForTask(work.taskId, ctx);
  await assert.rejects(f.harness.commit(tx => confirmAssistantStop(tx, work.id, 'stop-active'), ctx), /input is still active/);
  assert.equal((await f.harness.snapshot(AssistantPeers, ctx))?.work[work.id]?.stop?.confirmed, false);
  release.resolve(); assert.equal((await pending).status, 'done');
  await f.harness.commit(tx => confirmAssistantStop(tx, work.id, 'stop-active'), ctx);
  assert.equal((await f.harness.snapshot(AssistantPeers, ctx))?.work[work.id]?.stop?.confirmed, true);
});

test('stopping an original work freezes its descendant reports and confirms the native subtree from the leaves', async t => {
  const f = await fixture(t), parent = await f.claim(f.intent('parent'));
  const child = await f.claim(f.intent('child', pin('writer')), f.authority(parent.target, parent.id));
  await f.harness.waitForTask(parent.taskId, ctx); await f.harness.waitForTask(child.taskId, ctx);
  const shown = assistantWorkView(await f.harness.snapshot(AssistantPeers, ctx), parent.id); assert(shown);
  await f.harness.commit(tx => requestAssistantStop(tx, f.root.id, parent.id, shown.controlVersion, 'stop-chain', 300), ctx);
  const state = await f.harness.snapshot(AssistantPeers, ctx), nestedStop = state?.work[child.id]?.stop;
  assert(nestedStop); assert.equal(nestedStop.ancestor, parent.id); assert.equal(nestedStop.confirmed, false);
  await assert.rejects(f.harness.commit(tx => confirmAssistantStop(tx, parent.id, 'stop-chain'), ctx), /nested assistant/);
  await f.harness.commit(tx => confirmAssistantStop(tx, child.id, nestedStop.requestId), ctx);
  await f.harness.commit(tx => confirmAssistantStop(tx, parent.id, 'stop-chain'), ctx);
  assert.equal(await f.harness.commit(tx => outstandingAssistantWork(tx, f.root.id, f.authority().goal), ctx), false);
  await assert.rejects(f.claim(f.intent('repeat-child', pin('writer'))), /stopped/);
});

test('the exact native report turn can submit its Goal without waiting for itself to become done', async t => {
  const f = await fixture(t, true), work = await f.claim(f.intent('report-ready'));
  const peer = await f.harness.conversation(work.target, ctx); assert(peer);
  await (await peer.submit({ type: 'input', content: 'Complete evidence.', requestId: work.messageRequestId }, ctx)).wait(ctx);
  await f.harness.commit(tx => captureAssistantResult(tx, work.id), ctx);
  await f.harness.commit(async tx => Object.assign(await tx.doc(GoalDoc), { initialized: true, objective: 'Original Goal', phase: 'working' }), ctx);
  f.provider.setResponses([() => fauxAssistantMessage(fauxToolCall('task_submit', { summary: 'Original report was read.', artifacts: [] }), { stopReason: 'toolUse' })]);
  const settled = await (await f.root.submit({ type: 'input', content: 'Original peer report.', requestId: work.reportRequestId }, ctx)).wait(ctx);
  assert.equal(settled.status, 'done');
  const goal = await f.harness.snapshot(GoalDoc, ctx);
  assert.equal(goal?.phase, 'submitted'); assert.equal(goal?.candidate?.summary, 'Original report was read.');
});

test('an explicitly selected peer conversation must match its original source, role revision and effective scope', async t => {
  const f = await fixture(t), original = await f.claim(f.intent('standing'));
  const reused = await f.claim({ ...f.intent('existing'), mode: original.target });
  assert.equal(reused.target, original.target);
  for (const input of [{ ...f.intent('wrong-version', { ...pin('reader'), revision: 2 }), mode: original.target },
    { ...f.intent('narrowed-new-scope'), tools: [], mode: original.target }, { ...f.intent('unknown-conversation'), mode: 999 as ConversationId }]) {
    await assert.rejects(f.claim(input), /compatible original/);
  }
  const peer = await f.claim(f.intent('writer', pin('writer')));
  await assert.rejects(f.claim({ ...f.intent('other-source'), mode: original.target }, f.authority(peer.target, peer.id)), /compatible original|maximum active/);
});

test('an ordinary Goal without the feature does not acquire peer documents or a new submission gate', async t => {
  const f = await fixture(t); f.registry.install(goalExtension());
  await f.harness.commit(async tx => Object.assign(await tx.doc(GoalDoc), { initialized: true, objective: 'Existing Goal', phase: 'working' }), ctx);
  assert.equal(await f.harness.snapshot(AssistantPeers, ctx), undefined);
  f.provider.setResponses([() => fauxAssistantMessage(fauxToolCall('task_submit', { summary: 'Existing behavior.', artifacts: [] }), { stopReason: 'toolUse' })]);
  assert.equal((await (await f.root.submit({ type: 'input', content: 'Submit as before.' }, ctx)).wait(ctx)).status, 'done');
  assert.equal((await f.harness.snapshot(GoalDoc, ctx))?.phase, 'submitted');
  assert.equal(await f.harness.snapshot(AssistantPeers, ctx), undefined);
});

test('a peer cannot pass write to another role even when a caller presents an expanded transient tool list', async t => {
  const f = await fixture(t), parent = await f.claim(f.intent('fixed-reader'));
  const target = { ...pin('writer'), tools: ['read', 'write'] };
  await assert.rejects(f.claim({ ...f.intent('cannot-amplify', target), tools: ['write'] }, f.authority(parent.target, parent.id)), /source.*scope/);
  assert.equal((await f.harness.snapshot(AssistantPeers, ctx))?.work['cannot-amplify'], undefined);
});

test('an owned peer cannot present itself as a new root to reset original work limits or ancestry', async t => {
  const f = await fixture(t), parent = await f.claim(f.intent('original-source'));
  const authority = { ...f.authority(parent.target), root: parent.target };
  await assert.rejects(f.harness.commit(tx => claimAssistantWork(tx, authority, f.intent('fake-root', pin('writer')), async () => assert.fail('An owned peer must not allocate a new root.')), ctx), /original.*root|ownerless/);
});

test('invalid peer intent and file snapshot metadata fail before any native allocation', async t => {
  const f = await fixture(t), file = { path: join(process.cwd(), 'input.bin'), bytes: 1, sha256: 'a'.repeat(64) };
  const noCreate = async () => assert.fail('Invalid metadata must not allocate a native task.');
  for (const input of [{ ...f.intent('blank'), instructions: ' ' }, { ...f.intent('unsafe'), requestId: '__proto__' },
    { ...f.intent('mode'), mode: -1 as ConversationId }, { ...f.intent('coerced-mode'), mode: ['standing'] as unknown as ConversationId }, { ...f.intent('duplicate-tools'), tools: ['read', 'read'] },
    { ...f.intent('relative-file'), files: [{ ...file, path: '../outside.bin' }] }, { ...f.intent('negative-size'), files: [{ ...file, bytes: -1 }] },
    { ...f.intent('oversized-file'), files: [{ ...file, bytes: 5 * 1024 * 1024 + 1 }] }, { ...f.intent('invalid-hash'), files: [{ ...file, sha256: 'not-a-hash' }] },
    { ...f.intent('too-many-files'), files: Array.from({ length: 6 }, () => file) }]) {
    await assert.rejects(f.harness.commit(tx => claimAssistantWork(tx, f.authority(), input, noCreate), ctx), { status: 400 });
  }
  assert.equal(await f.harness.snapshot(AssistantPeers, ctx), undefined);
});

test('committed peer identity, native ownership and original stop survive SQLite reopen without allocating or resurrecting work', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'kada-peer-state-'))), models = createModels();
  const provider = fauxProvider({ provider: 'peer-state', models: [{ id: 'scripted' }] }); models.setProvider(provider.provider);
  const registry = createRegistry(); registry.install(defineExtension({ name: 'state_persistence_probe', tasks: [Dummy] }));
  const open = () => openNodeSqliteStorage(join(directory, 'session.sqlite')).then(storage => Harness.open(storage, { models, registry }, ctx));
  let harness = await open();
  t.after(async () => { await harness.close(ctx); await rm(directory, { recursive: true, force: true, maxRetries: 5 }); });
  let root = await harness.root(ctx, { agent: { model: pin('reader').model } });
  const intent: AssistantWorkIntent = { requestId: 'persisted', assistant: pin('reader'), instructions: 'Original peer work.', tools: ['read'], mode: 'standing', files: [] };
  const first = await harness.commit(tx => claimAssistantWork(tx, admission(root.id), intent, allocateNative(tx, root.id)), ctx);
  await harness.close(ctx); harness = await open(); root = await harness.root(ctx);
  const original = await harness.commit(tx => claimAssistantWork(tx, admission(root.id), intent, async () => assert.fail('Replay must not allocate another peer.')), ctx);
  assert.equal(original.id, first.id); assert.equal(original.taskId, first.taskId); assert.equal(original.target, first.target);
  const state = await harness.snapshot(AssistantPeers, ctx); assert(state);
  assert.equal((await harness.commit(tx => tx.conversation(first.target), ctx))?.owner?.taskId, state.seats[String(first.target)]?.anchor);
  const shown = assistantWorkView(state, first.id); assert(shown);
  await harness.commit(tx => requestAssistantStop(tx, root.id, first.id, shown.controlVersion, 'persistent-stop', 200), ctx);
  await harness.waitForTask(first.taskId, ctx); await harness.commit(tx => confirmAssistantStop(tx, first.id, 'persistent-stop'), ctx);
  await harness.close(ctx); harness = await open(); root = await harness.root(ctx);
  const replay = await harness.commit(tx => claimAssistantWork(tx, admission(root.id), intent, async () => assert.fail('Stopped replay must not allocate.')), ctx);
  assert.equal(replay.stop?.confirmed, true);
  await assert.rejects(harness.commit(tx => claimAssistantWork(tx, admission(root.id), { ...intent, requestId: 'cannot-restart' }, allocateNative(tx, root.id)), ctx), /stopped/);
  const current = await harness.snapshot(AssistantPeers, ctx); assert.equal(Object.keys(current!.work).length, 1); assert.equal(Object.keys(current!.seats).length, 1);
});

test('a peer that inherits Root Goal tools cannot mutate the original Goal or read its private requirements', async t => {
  const f = await fixture(t, true), work = await f.claim(f.intent('do-not-submit-root'));
  await f.harness.commit(async tx => Object.assign(await tx.doc(GoalDoc), { initialized: true, objective: 'PRIVATE_ROOT_REQUIREMENT_593', phase: 'working' }), ctx);
  let step = 0;
  f.provider.setResponses(Array.from({ length: 5 }, () => () => {
    const calls = [() => fauxAssistantMessage(fauxToolCall('task_status', {}), { stopReason: 'toolUse' }),
      () => fauxAssistantMessage(fauxToolCall('task_submit', { summary: 'Peer must not submit Root.', artifacts: [] }), { stopReason: 'toolUse' }),
      () => fauxAssistantMessage(fauxToolCall('task_blocked', { reason: 'Peer must not block Root.' }), { stopReason: 'toolUse' })];
    return step < calls.length ? calls[step++]!() : fauxAssistantMessage('Own result only.');
  }));
  const peer = await f.harness.conversation(work.target, ctx); assert(peer);
  await (await peer.submit({ type: 'input', content: 'Return an independent result.', requestId: work.messageRequestId }, ctx)).wait(ctx);
  const goal = await f.harness.snapshot(GoalDoc, ctx); assert.equal(goal?.phase, 'working'); assert.equal(goal?.candidate, null);
  const context = await peer.context(ctx);
  assert.doesNotMatch(JSON.stringify(context.messages.filter(message => message.role === 'toolResult')), /PRIVATE_ROOT_REQUIREMENT_593/);
  assert(context.messages.filter(message => message.role === 'toolResult').every(message => message.isError));
});

test('handoff depth counts work edges consistently whether the source task has a named role or not', async t => {
  for (const sourceRole of [undefined, { id: 'chief', revision: 1 }]) {
    const f = await fixture(t);
    const first = await f.claim(f.intent('depth-first'), { ...f.authority(), sourceRole, maxDepth: 2 });
    const second = await f.claim(f.intent('depth-second', pin('writer')), { ...f.authority(first.target, first.id), sourceRole, maxDepth: 2 });
    assert.equal(first.depth, 1); assert.equal(second.depth, 2);
    await assert.rejects(f.claim(f.intent('depth-third', pin('third')), { ...f.authority(second.target, second.id), sourceRole, maxDepth: 2 }), /depth/);
  }
});

test('a new work conversation is not silently adopted as the default standing conversation', async t => {
  const f = await fixture(t), authority = { ...f.authority(), maxPeers: 4 };
  const separate = await f.claim({ ...f.intent('new-first'), mode: 'new' }, authority);
  const standing = await f.claim(f.intent('standing-later'), authority);
  assert.notEqual(standing.target, separate.target);
  assert.equal((await f.claim(f.intent('same-standing'), authority)).target, standing.target);
  assert.equal((await f.claim({ ...f.intent('explicit-private'), mode: separate.target }, authority)).target, separate.target);
  const state = await f.harness.snapshot(AssistantPeers, ctx); assert(state);
  assert.equal(state.seats[String(separate.target)]?.kind, 'new');
  assert.equal(state.seats[String(standing.target)]?.kind, 'standing');
});
