import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, Type, type FauxResponseStep, type ToolResultMessage } from '@earendil-works/pi-ai';
import { configure, createRegistry, defineExtension, defineTool, Harness, section, UserEntry, type Conversation, type Extension, type JsonObject } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { Assistants } from '../src/assistants.js';
import { AssistantPeers, assistantWorkView } from '../src/assistant-peer-state.js';
import { assistantPeersExtension, stopAssistantWork, type AssistantPeerControl } from '../src/assistant-peers.js';
import { GoalDoc, goalExtension } from '../src/goal.js';
import { Workspace } from '../src/workspace.js';
import { localEnvironment, localExecution } from '../src/execution.js';
import { SerialQueue } from '../src/util.js';
import { hasTool, until } from './helpers.js';

const call = (name: string, args: JsonObject) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' });
const value = (message: ToolResultMessage) => JSON.parse(message.content.filter(part => part.type === 'text').map(part => part.text).join(''));

async function fixture(t: test.TestContext, respond: FauxResponseStep, extras: Extension[] = []) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'kada-assistant-peers-'))), path = join(directory, 'workspace');
  await mkdir(path); const workspace = await Workspace.open(path), models = createModels();
  const model = { provider: 'assistant-peers-test', modelId: 'scripted' }, provider = fauxProvider({ provider: model.provider, models: [{ id: model.modelId }] });
  provider.setResponses(Array.from({ length: 60 }, () => respond)); models.setProvider(provider.provider);
  const roles = new Assistants(directory, models), registry = createRegistry(), queue = new SerialQueue();
  const reports: string[] = [];
  let current: { harness: Harness; root: Conversation } | undefined, enabled = true;
  const coding = localExecution(), goal = goalExtension({ assistantPeers: true });
  const extension = assistantPeersExtension({ roles, workspace, models, defaultModel: model, maxPeers: 3, extensions: () => [coding, ...extras],
    withControl: action => queue.run(() => {
      assert(current);
      const control: AssistantPeerControl = { root: current.root.id, project: path, enabled, requiresConfirmation: false, deadlineAt: Date.now() + 60_000 };
      return action(control);
    }) });
  for (const item of [coding, goal, extension, ...extras]) registry.install(item);
  const open = async () => {
    const storage = await openNodeSqliteStorage(join(directory, 'session.sqlite'));
    const harness = await Harness.open(storage, { models, registry, env: ({ cwd }) => localEnvironment(cwd ?? path), onReport: (error, info) => reports.push(JSON.stringify({ error: String(error), info })) }, ctx);
    const root = await harness.root(ctx, { agent: { model, cwd: path, extensions: [coding, goal, extension, ...extras] } });
    current = { harness, root };
  };
  await open();
  await current!.harness.commit(async tx => Object.assign(await tx.doc(GoalDoc), { initialized: true, objective: 'PRIVATE_SOURCE_GOAL_529', phase: 'working' }), ctx);
  t.after(async () => { await current?.harness.close(ctx); await rm(directory, { recursive: true, force: true, maxRetries: 5 }); });
  return { roles, workspace, provider, models, reports, withControl: <T>(action: (control: AssistantPeerControl) => Promise<T>) => queue.run(() => {
    assert(current); return action({ root: current.root.id, project: path, enabled, requiresConfirmation: false, deadlineAt: Date.now() + 60_000 });
  }), get harness() { return current!.harness; }, get root() { return current!.root; },
    enabled: (next: boolean) => { enabled = next; }, reopen: async () => { await current!.harness.close(ctx); await open(); } };
}

test('the real assistant dispatcher reuses a pinned standing conversation after reopen and reports each work once', async t => {
  let roleId = '', peerCalls = 0;
  const f = await fixture(t, context => {
    if (!hasTool(context, 'task_submit')) {
      peerCalls++; assert(JSON.stringify(context.messages).includes('PEER_READER_614'));
      assert(!JSON.stringify(context.messages).includes('PRIVATE_SOURCE_GOAL_529')); assert(!hasTool(context, 'write'));
      if (peerCalls === 2) assert(JSON.stringify(context.messages).includes('Remember PEER_CODE_814.'));
      return fauxAssistantMessage('PEER_CODE_814');
    }
    const last = context.messages.filter(message => message.role === 'user' || message.role === 'toolResult').at(-1)!;
    if (last.role === 'user' && (last.content === 'FIRST' || last.content === 'SECOND')) return call('assistant_assign', { assistant: { id: roleId, revision: 1 },
      instructions: last.content === 'FIRST' ? 'Remember PEER_CODE_814.' : 'Recall the original code.', mode: 'standing' });
    return fauxAssistantMessage('Original work state noted.');
  });
  roleId = (await f.roles.create({ workspace: f.workspace.root, name: 'Reader', instructions: 'PEER_READER_614', tools: ['read'] })).id;
  const send = async (text: string) => {
    assert.equal((await (await f.root.submit({ type: 'input', content: text, requestId: text }, ctx)).wait(ctx)).status, 'done');
    const state = await f.harness.snapshot(AssistantPeers, ctx); assert(state);
    for (const work of Object.values(state.work)) {
      const task = await f.harness.waitForTask(work.taskId, ctx);
      assert.equal(task.state.outcome.status, 'completed', JSON.stringify({ task, reports: f.reports }));
    }
    await f.root.waitForIdle(ctx); return (await f.harness.snapshot(AssistantPeers, ctx))!;
  };
  const first = await send('FIRST'); assert.equal(peerCalls, 1);
  await f.reopen(); assert.equal(peerCalls, 1);
  const second = await send('SECOND'); assert.equal(peerCalls, 2); assert.equal(Object.keys(second.work).length, 2);
  assert.equal(new Set(Object.values(second.work).map(work => work.target)).size, 1); assert.equal(Object.keys(second.seats).length, 1);
  const context = await f.root.context(ctx);
  assert.equal(context.messages.filter(message => message.role === 'user' && String(message.content).startsWith('ASSISTANT_REPORT ')).length, 2, JSON.stringify(f.reports));
  assert(Object.values(second.work).every(work => work.result?.status === 'done'));
  const replay = await f.root.submit({ type: 'input', content: 'SECOND', requestId: 'SECOND' }, ctx); assert.equal((await replay.wait(ctx)).status, 'done'); assert.equal(peerCalls, 2);
  assert.deepEqual(Object.keys(first.seats), Object.keys(second.seats));
});

test('a recipient uses only its fixed action intersection, cannot inspect the source Goal, and Root reads the exact returned native result', async t => {
  let roleId = '', seen = 0;
  const f = await fixture(t, context => {
    const results = context.messages.filter((message): message is ToolResultMessage => message.role === 'toolResult');
    if (!hasTool(context, 'task_submit')) {
      assert(!hasTool(context, 'write')); assert(!hasTool(context, 'task_status')); assert(!hasTool(context, 'assistant_create'));
      assert(!JSON.stringify(context.messages).includes('PRIVATE_SOURCE_GOAL_529')); seen++;
      if (!results.some(result => result.toolName === 'write')) return call('write', { path: 'forbidden.txt', content: 'bad' });
      if (!results.some(result => result.toolName === 'task_status')) return call('task_status', {});
      if (!results.some(result => result.toolName === 'read')) return call('read', { path: join(f.workspace.root, 'seed.txt') });
      assert.equal(results.find(result => result.toolName === 'write')!.isError, true); assert.equal(results.find(result => result.toolName === 'task_status')!.isError, true);
      assert.equal(results.find(result => result.toolName === 'read')!.isError, false); return fauxAssistantMessage('ACTUAL_PEER_RESULT_792');
    }
    const last = context.messages.filter(message => message.role === 'user').at(-1)?.content;
    if (typeof last === 'string' && last.startsWith('ASSISTANT_REPORT ')) {
      const receipt = JSON.parse(last.slice('ASSISTANT_REPORT '.length));
      if (!results.some(result => result.toolName === 'assistant_result')) return call('assistant_result', { id: receipt.id });
      assert(JSON.stringify(value(results.find(result => result.toolName === 'assistant_result')!)).includes('ACTUAL_PEER_RESULT_792'));
      return call('task_submit', { summary: 'Original result read.', artifacts: [] });
    }
    if (!results.some(result => result.toolName === 'assistant_assign')) return call('assistant_assign', { assistant: { id: roleId, revision: 1 }, instructions: 'Read the seed and report.' });
    return fauxAssistantMessage('Waiting for the original report.');
  });
  await writeFile(join(f.workspace.root, 'seed.txt'), 'ACTUAL_PEER_INPUT_741');
  roleId = (await f.roles.create({ workspace: f.workspace.root, name: 'Read only', instructions: 'Read the actual input.', tools: ['read'] })).id;
  await (await f.root.submit({ type: 'input', content: 'Inspect the original evidence.' }, ctx)).wait(ctx);
  const complete = await until(() => f.harness.snapshot(GoalDoc, ctx), goal => goal?.phase === 'submitted');
  assert.equal(complete?.candidate?.summary, 'Original result read.'); assert(seen >= 4);
  await assert.rejects(readFile(join(f.workspace.root, 'forbidden.txt')), { code: 'ENOENT' });
  const state = await f.harness.snapshot(AssistantPeers, ctx); assert.equal(Object.keys(state!.work).length, 1);
});

test('independent assignments queue after the current answer and keep their distinct original results', async t => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); let roleId = '';
  const hold = defineTool({ name: 'hold', description: 'Hold the first work.', parameters: Type.Object({}), replay: 'safe', execute: async () => {
    entered.resolve(); await release.promise; return { output: [{ type: 'text', text: 'First work released.' }] };
  } });
  t.after(() => release.resolve());
  const f = await fixture(t, context => {
    const last = context.messages.filter(message => message.role === 'user').at(-1)?.content;
    if (!hasTool(context, 'task_submit')) {
      const start = context.messages.findLastIndex(message => message.role === 'user');
      if (last === 'FIRST_JOB' && !context.messages.slice(start).some(message => message.role === 'toolResult')) return call('hold', {});
      return fauxAssistantMessage(last === 'FIRST_JOB' ? 'FIRST_ORIGINAL_817' : 'SECOND_ORIGINAL_392');
    }
    const latest = context.messages.filter(message => message.role === 'user' || message.role === 'toolResult').at(-1)!;
    if (latest.role === 'user' && (last === 'FIRST_JOB' || last === 'SECOND_JOB')) return call('assistant_assign', { assistant: { id: roleId, revision: 1 }, instructions: String(last) });
    return fauxAssistantMessage('Accepted independent work.');
  }, [defineExtension({ name: 'peer_queue_probe', tools: [hold] })]);
  roleId = (await f.roles.create({ workspace: f.workspace.root, name: 'Queue worker', instructions: 'Keep each job separate.', tools: ['hold'] })).id;
  await (await f.root.submit({ type: 'input', content: 'FIRST_JOB' }, ctx)).wait(ctx); await entered.promise;
  await (await f.root.submit({ type: 'input', content: 'SECOND_JOB' }, ctx)).wait(ctx);
  const assigned = await until(() => f.harness.inspect(ctx), state => state.submissions.filter(input => input.conversationId !== f.root.id).length === 2);
  assert.deepEqual(assigned.submissions.filter(input => input.conversationId !== f.root.id).map(input => input.status).sort(), ['placed', 'queued']);
  release.resolve();
  const before = (await f.harness.snapshot(AssistantPeers, ctx))!;
  for (const work of Object.values(before.work)) assert.equal((await f.harness.waitForTask(work.taskId, ctx)).state.outcome.status, 'completed');
  await f.root.waitForIdle(ctx);
  const state = (await f.harness.snapshot(AssistantPeers, ctx))!, results: string[] = [];
  for (const work of Object.values(state.work)) {
    assert(work.result?.status === 'done');
    const peer = await f.harness.conversation(work.target, ctx); assert(peer);
    const original = await peer.context(ctx, { at: work.result.answer });
    const answer = original.messages.filter(message => message.role === 'assistant').at(-1);
    results.push(JSON.stringify(answer));
  }
  assert(results[0]!.includes('FIRST_ORIGINAL_817')); assert(results[1]!.includes('SECOND_ORIGINAL_392'));
  assert.equal(new Set(Object.values(state.work).map(work => work.target)).size, 1);
});

test('new conversations remain separate and explicit compatible conversation reuse preserves its own history', async t => {
  let roleId = '', previous = 0;
  const f = await fixture(t, context => {
    if (!hasTool(context, 'task_submit')) return fauxAssistantMessage('Work acknowledged.');
    const last = context.messages.filter(message => message.role === 'user' || message.role === 'toolResult').at(-1)!;
    if (last.role === 'user' && ['NEW', 'STANDING', 'EXISTING'].includes(String(last.content))) return call('assistant_assign', {
      assistant: { id: roleId, revision: 1 }, instructions: String(last.content), mode: last.content === 'NEW' ? 'new' : last.content === 'EXISTING' ? previous : 'standing',
    });
    return fauxAssistantMessage('Receipt retained.');
  });
  roleId = (await f.roles.create({ workspace: f.workspace.root, name: 'Modes', instructions: 'Keep conversation identity.', tools: [] })).id;
  const send = async (content: string) => {
    await (await f.root.submit({ type: 'input', content }, ctx)).wait(ctx);
    const state = (await f.harness.snapshot(AssistantPeers, ctx))!;
    for (const work of Object.values(state.work)) await f.harness.waitForTask(work.taskId, ctx);
    await f.root.waitForIdle(ctx); return Object.values(state.work).at(-1)!;
  };
  const first = await send('NEW'); previous = first.target;
  const standing = await send('STANDING'); assert.notEqual(standing.target, first.target);
  const existing = await send('EXISTING'); assert.equal(existing.target, first.target);
  const peer = await f.harness.conversation(first.target, ctx); assert(peer);
  const history = JSON.stringify((await peer.context(ctx)).messages); assert(history.includes('NEW')); assert(history.includes('EXISTING')); assert(!history.includes('STANDING'));
});

test('nested handoffs settle the original parent only after its child report and refuse ancestry cycles', async t => {
  let parentId = '', childId = '', cycles = 0;
  const f = await fixture(t, context => {
    const system = JSON.stringify(context.messages.filter(message => message.role === 'system'));
    const results = context.messages.filter((message): message is ToolResultMessage => message.role === 'toolResult');
    if (system.includes('NESTED_CHILD_791')) {
      if (!results.some(result => result.toolName === 'assistant_assign')) return call('assistant_assign', { assistant: { id: parentId, revision: 1 }, instructions: 'Try the ancestor.' });
      assert.equal(results.find(result => result.toolName === 'assistant_assign')!.isError, true); cycles++; return fauxAssistantMessage('CHILD_EVIDENCE_619');
    }
    if (system.includes('NESTED_PARENT_318')) {
      const last = context.messages.filter(message => message.role === 'user').at(-1)?.content;
      if (typeof last === 'string' && last.startsWith('ASSISTANT_REPORT ')) return fauxAssistantMessage('PARENT_AFTER_CHILD_452');
      if (!results.some(result => result.toolName === 'assistant_assign')) return call('assistant_assign', { assistant: { id: childId, revision: 1 }, instructions: 'Inspect the nested evidence.' });
      return fauxAssistantMessage('Parent awaits original child report.');
    }
    const last = context.messages.filter(message => message.role === 'user' || message.role === 'toolResult').at(-1)!;
    if (last.role === 'user' && last.content === 'START') return call('assistant_assign', { assistant: { id: parentId, revision: 1 }, instructions: 'Coordinate the child evidence.' });
    return fauxAssistantMessage('Root retains original goal.');
  });
  const tools = ['assistant_assign'];
  parentId = (await f.roles.create({ workspace: f.workspace.root, name: 'Nested parent', instructions: 'NESTED_PARENT_318', tools })).id;
  childId = (await f.roles.create({ workspace: f.workspace.root, name: 'Nested child', instructions: 'NESTED_CHILD_791', tools })).id;
  await (await f.root.submit({ type: 'input', content: 'START' }, ctx)).wait(ctx);
  const initial = (await f.harness.snapshot(AssistantPeers, ctx))!;
  const parent = Object.values(initial.work).find(work => work.source === f.root.id)!;
  assert.equal((await f.harness.waitForTask(parent.taskId, ctx)).state.outcome.status, 'completed'); await f.root.waitForIdle(ctx);
  const state = (await f.harness.snapshot(AssistantPeers, ctx))!; assert.equal(Object.keys(state.work).length, 2); assert.equal(cycles, 1);
  const work = state.work[parent.id]!; assert.equal(work.inputRequests.length, 2); assert(work.result?.status === 'done');
  const peer = await f.harness.conversation(work.target, ctx); assert(peer);
  const answer = (await peer.context(ctx, { at: work.result.answer })).messages.filter(message => message.role === 'assistant').at(-1);
  assert(JSON.stringify(answer).includes('PARENT_AFTER_CHILD_452'));
  assert.equal((await f.root.context(ctx)).messages.filter(message => message.role === 'user' && String(message.content).startsWith('ASSISTANT_REPORT ')).length, 1);
});

test('loaded and nested tools cannot expand a recipient scope', async t => {
  let roleId = '', effects = 0;
  const mutate = defineTool({ name: 'peer_mutate', description: 'Count a forbidden effect.', parameters: Type.Object({}), replay: 'safe', execute: async () => { effects++; return { output: [] }; } });
  const load = defineTool({ name: 'peer_load', description: 'Try loading an unassigned tool.', parameters: Type.Object({}), replay: 'safe', execute: async () => ({ output: [], control: { addTools: ['peer_mutate'] } }) });
  const nested = defineTool({ name: 'peer_nested', description: 'Try a nested unassigned tool.', parameters: Type.Object({}), replay: 'safe', execute: async (_args, api, context) => {
    const result = await api.executeTool('peer_mutate', {}, context); assert.equal(result.isError, true); return { output: [] };
  } });
  const f = await fixture(t, context => {
    const results = context.messages.filter((message): message is ToolResultMessage => message.role === 'toolResult');
    if (!hasTool(context, 'task_submit')) {
      assert(!hasTool(context, 'peer_mutate'));
      if (!results.some(result => result.toolName === 'peer_load')) return call('peer_load', {});
      if (!results.some(result => result.toolName === 'peer_nested')) return call('peer_nested', {});
      return fauxAssistantMessage('No permission amplification.');
    }
    if (!results.some(result => result.toolName === 'assistant_assign')) return call('assistant_assign', { assistant: { id: roleId, revision: 1 }, instructions: 'Exercise the fixed scope.' });
    return fauxAssistantMessage('Original assignment retained.');
  }, [defineExtension({ name: 'peer_loader_probe', tools: [load, nested, mutate] })]);
  roleId = (await f.roles.create({ workspace: f.workspace.root, name: 'Loader', instructions: 'Keep the ceiling.', tools: ['peer_load', 'peer_nested'] })).id;
  await (await f.root.submit({ type: 'input', content: 'Test scopes.' }, ctx)).wait(ctx);
  const state = (await f.harness.snapshot(AssistantPeers, ctx))!;
  for (const work of Object.values(state.work)) assert.equal((await f.harness.waitForTask(work.taskId, ctx)).state.outcome.status, 'completed');
  await f.root.waitForIdle(ctx); assert.equal(effects, 0);
});

test('a result held while the source awaits its user is reported once after the original goal resumes', async t => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); let roleId = '';
  const hold = defineTool({ name: 'hold', description: 'Hold a result for the source question.', parameters: Type.Object({}), replay: 'safe', execute: async () => {
    entered.resolve(); await release.promise; return { output: [] };
  } });
  t.after(() => release.resolve());
  const f = await fixture(t, context => {
    const results = context.messages.filter(message => message.role === 'toolResult');
    if (!hasTool(context, 'task_submit')) return results.some(result => result.toolName === 'hold') ? fauxAssistantMessage('HELD_ORIGINAL_517') : call('hold', {});
    if (!results.some(result => result.toolName === 'assistant_assign')) return call('assistant_assign', { assistant: { id: roleId, revision: 1 }, instructions: 'Return the held result.' });
    return fauxAssistantMessage('Source waits for its own question.');
  }, [defineExtension({ name: 'peer_held_report', tools: [hold] })]);
  roleId = (await f.roles.create({ workspace: f.workspace.root, name: 'Held result', instructions: 'Retain the original result.', tools: ['hold'] })).id;
  await (await f.root.submit({ type: 'input', content: 'Start original work.' }, ctx)).wait(ctx); await entered.promise;
  await f.harness.commit(async tx => { (await tx.doc(GoalDoc)).phase = 'waiting_user'; }, ctx); release.resolve();
  await until(() => f.harness.snapshot(AssistantPeers, ctx), state => Object.values(state?.work ?? {}).some(work => !!work.result));
  assert.equal((await f.root.context(ctx)).messages.filter(message => message.role === 'user' && String(message.content).startsWith('ASSISTANT_REPORT ')).length, 0);
  await f.harness.commit(async tx => { (await tx.doc(GoalDoc)).phase = 'working'; }, ctx);
  const reports = await until(async () => (await f.root.context(ctx)).messages.filter(message => message.role === 'user' && String(message.content).startsWith('ASSISTANT_REPORT ')), items => items.length === 1);
  assert.equal(reports.length, 1);
});

test('a declared deferred tool stays discoverable without granting an undeclared tool', async t => {
  let roleId = '', effects = 0;
  const deferred = defineTool({ name: 'peer_deferred', description: 'An enabled but deferred source action.', deferred: true, parameters: Type.Object({}), replay: 'safe', execute: async () => {
    effects++; return { output: [{ type: 'text', text: 'Declared action completed.' }] };
  } });
  const load = defineTool({ name: 'peer_load', description: 'Load the enabled action.', parameters: Type.Object({}), replay: 'safe', execute: async () => ({ output: [], control: { addTools: ['peer_deferred'] } }) });
  const f = await fixture(t, context => {
    const results = context.messages.filter(message => message.role === 'toolResult');
    if (!hasTool(context, 'task_submit')) {
      if (!results.some(result => result.toolName === 'peer_load')) { assert(!hasTool(context, 'peer_deferred')); return call('peer_load', {}); }
      assert(hasTool(context, 'peer_deferred'));
      return results.some(result => result.toolName === 'peer_deferred') ? fauxAssistantMessage('Declared discovery completed.') : call('peer_deferred', {});
    }
    assert(!hasTool(context, 'peer_deferred'));
    if (!results.some(result => result.toolName === 'assistant_assign')) return call('assistant_assign', { assistant: { id: roleId, revision: 1 }, instructions: 'Load the declared tool.' });
    return fauxAssistantMessage('Original tools retained.');
  }, [defineExtension({ name: 'peer_deferred_probe', tools: [load, deferred] })]);
  roleId = (await f.roles.create({ workspace: f.workspace.root, name: 'Deferred worker', instructions: 'Use only declared tools.', tools: ['peer_load', 'peer_deferred'] })).id;
  await (await f.root.submit({ type: 'input', content: 'Discover original action.' }, ctx)).wait(ctx);
  const state = (await f.harness.snapshot(AssistantPeers, ctx))!;
  for (const work of Object.values(state.work)) assert.equal((await f.harness.waitForTask(work.taskId, ctx)).state.outcome.status, 'completed');
  await f.root.waitForIdle(ctx); assert.equal(effects, 1);
});

test('the original peer model and role survive native compaction and a later catalog change', async t => {
  let roleId = '', peerCalls = 0;
  const f = await fixture(t, context => {
    assert(hasTool(context, 'task_submit'));
    const last = context.messages.filter(message => message.role === 'user' || message.role === 'toolResult').at(-1)!;
    if (last.role === 'user' && last.content === 'ASSIGN') return call('assistant_assign', { assistant: { id: roleId, revision: 1 }, instructions: 'Remember ORIGINAL_PIN_618.' });
    return fauxAssistantMessage('Original assignment noted.');
  });
  const model = { provider: 'peer-dedicated', modelId: 'original' }, provider = fauxProvider({ provider: model.provider, models: [{ id: model.modelId }] });
  provider.setResponses(Array.from({ length: 16 }, () => context => {
    const system = JSON.stringify(context.messages.filter(message => message.role === 'system'));
    if (system.includes('context summarization assistant')) return fauxAssistantMessage('Retain ORIGINAL_PIN_618 and the original work.');
    peerCalls++; assert(system.includes('PEER_ORIGINAL_POLICY_714')); assert(!system.includes('PEER_REPLACEMENT_POLICY_382')); assert(!hasTool(context, 'write'));
    return fauxAssistantMessage('ORIGINAL_PIN_618');
  })); f.models.setProvider(provider.provider);
  roleId = (await f.roles.create({ workspace: f.workspace.root, name: 'Dedicated model', instructions: 'PEER_ORIGINAL_POLICY_714', model, tools: ['read'] })).id;
  await (await f.root.submit({ type: 'input', content: 'ASSIGN' }, ctx)).wait(ctx);
  const state = (await f.harness.snapshot(AssistantPeers, ctx))!, work = Object.values(state.work)[0]!;
  await f.harness.waitForTask(work.taskId, ctx); await f.root.waitForIdle(ctx);
  let peer = await f.harness.conversation(work.target, ctx); assert(peer);
  for (let i = 0; i < 2; i++) await (await peer.submit({ type: 'write', entry: { kind: UserEntry.kind, model: [{ role: 'user', content: 'Historical material. '.repeat(3000), timestamp: Date.now() }] } }, ctx)).wait(ctx);
  const compacted = (await f.harness.waitForTask(await peer.compact('Preserve the original code.', ctx), ctx)).state.outcome;
  assert(compacted.status === 'completed' && compacted.result.submissionId !== undefined);
  await (await f.harness.submission(compacted.result.submissionId, ctx))!.wait(ctx);
  await f.roles.update(roleId, { revision: 1, instructions: 'PEER_REPLACEMENT_POLICY_382', model: { provider: 'assistant-peers-test', modelId: 'scripted' }, tools: ['write'] });
  await f.reopen(); peer = await f.harness.conversation(work.target, ctx); assert(peer);
  await (await peer.submit({ type: 'input', content: 'Recall original code after compaction.' }, ctx)).wait(ctx);
  assert.equal(peerCalls, 2); assert.deepEqual((await f.harness.snapshot(AssistantPeers, ctx))!.seats[String(peer.id)]!.pin.model, model);
});

test('explicit rework keeps the original work link, conversation and role after the catalog is edited and archived', async t => {
  let roleId = '', workId = '', peerCalls = 0;
  const f = await fixture(t, context => {
    if (!hasTool(context, 'task_submit')) {
      peerCalls++; const text = JSON.stringify(context.messages); assert(text.includes('ORIGINAL_REWORK_ROLE_791')); assert(!text.includes('REPLACEMENT_REWORK_ROLE_318')); assert(!hasTool(context, 'write'));
      if (peerCalls === 2) { assert(text.includes('Original evidence please.')); assert(text.includes('FIRST_REWORK_RESULT_614')); }
      return fauxAssistantMessage(peerCalls === 1 ? 'FIRST_REWORK_RESULT_614' : 'CORRECTED_REWORK_RESULT_928');
    }
    const last = context.messages.filter(message => message.role === 'user' || message.role === 'toolResult').at(-1)!;
    if (last.role === 'user' && last.content === 'FIRST') return call('assistant_assign', { assistant: { id: roleId, revision: 1 }, instructions: 'Original evidence please.' });
    if (last.role === 'user' && last.content === 'REWORK') return call('assistant_rework', { id: workId, instructions: 'Correct the original evidence.' });
    return fauxAssistantMessage('Original result retained.');
  });
  roleId = (await f.roles.create({ workspace: f.workspace.root, name: 'Original rework', instructions: 'ORIGINAL_REWORK_ROLE_791', tools: ['read'] })).id;
  await (await f.root.submit({ type: 'input', content: 'FIRST' }, ctx)).wait(ctx);
  const first = Object.values((await f.harness.snapshot(AssistantPeers, ctx))!.work)[0]!; workId = first.id;
  await f.harness.waitForTask(first.taskId, ctx); await f.root.waitForIdle(ctx);
  await f.roles.update(roleId, { revision: 1, instructions: 'REPLACEMENT_REWORK_ROLE_318', tools: ['write'], archived: true }); await f.reopen();
  await (await f.root.submit({ type: 'input', content: 'REWORK' }, ctx)).wait(ctx);
  const state = (await f.harness.snapshot(AssistantPeers, ctx))!; assert.equal(Object.keys(state.work).length, 2);
  const revised = Object.values(state.work).at(-1)!;
  await f.harness.waitForTask(revised.taskId, ctx); await f.root.waitForIdle(ctx);
  assert.equal(revised.target, first.target); assert.deepEqual(revised.assistant, first.assistant);
  assert.equal(revised.reworkOf, first.id); assert.equal(peerCalls, 2);
});

test('the execution directory pages actual project metadata without leaking role instructions and supplies an assignable revision', async t => {
  const f = await fixture(t, context => {
    if (!hasTool(context, 'task_submit')) return fauxAssistantMessage('Actual directory work completed.');
    const results = context.messages.filter((message): message is ToolResultMessage => message.role === 'toolResult');
    const found = results.find(result => result.toolName === 'assistant_directory');
    if (!found) return call('assistant_directory', { limit: 1 });
    const directory = value(found); assert.equal(directory.items.length, 1); assert.equal(directory.total, 2); assert.equal(directory.nextOffset, 1);
    assert(!JSON.stringify(directory).includes('PRIVATE_DIRECTORY_INSTRUCTIONS_917'));
    if (!results.some(result => result.toolName === 'assistant_assign')) return call('assistant_assign', {
      assistant: { id: directory.items[0].id, revision: directory.items[0].revision }, instructions: 'Use the actual directory role.',
    });
    return fauxAssistantMessage('Actual directory receipt retained.');
  });
  await f.roles.create({ workspace: f.workspace.root, name: 'Directory role', instructions: 'PRIVATE_DIRECTORY_INSTRUCTIONS_917', tools: [] });
  await f.roles.create({ workspace: f.workspace.root, name: 'Another role', instructions: 'Keep this separate.', tools: [] });
  await (await f.root.submit({ type: 'input', content: 'Select a directory role.' }, ctx)).wait(ctx);
  const state = (await f.harness.snapshot(AssistantPeers, ctx))!; assert.equal(Object.keys(state.work).length, 1);
  for (const work of Object.values(state.work)) assert.equal((await f.harness.waitForTask(work.taskId, ctx)).state.outcome.status, 'completed');
});

test('stopping an original running work preserves the same peer queued work and keeps the user stop after restart', async t => {
  const entered = Promise.withResolvers<void>(); let roleId = '', effects = 0, aborted = false;
  const hold = defineTool({ name: 'hold', description: 'Hold one original work until stopped.', parameters: Type.Object({}), replay: 'safe', execute: async (_args, _api, context) => {
    const signal = context.abortSignal; assert(signal); entered.resolve();
    await new Promise<void>(resolve => signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }));
    return { output: [] };
  } });
  const f = await fixture(t, context => {
    const last = context.messages.filter(message => message.role === 'user').at(-1)?.content;
    if (!hasTool(context, 'task_submit')) {
      if (last === 'STOP_FIRST') return call('hold', {});
      assert.equal(last, 'KEEP_SECOND'); effects++; return fauxAssistantMessage('SECOND_WORK_SURVIVED_714');
    }
    const latest = context.messages.filter(message => message.role === 'user' || message.role === 'toolResult').at(-1)!;
    if (latest.role === 'user' && ['STOP_FIRST', 'KEEP_SECOND', 'RETRY_STOPPED'].includes(String(last))) return call('assistant_assign', { assistant: { id: roleId, revision: 1 }, instructions: String(last) });
    return fauxAssistantMessage('Original state retained.');
  }, [defineExtension({ name: 'peer_stop_probe', tools: [hold] })]);
  roleId = (await f.roles.create({ workspace: f.workspace.root, name: 'Stopped worker', instructions: 'Keep work identities.', tools: ['hold'] })).id;
  await (await f.root.submit({ type: 'input', content: 'STOP_FIRST' }, ctx)).wait(ctx); await entered.promise;
  await (await f.root.submit({ type: 'input', content: 'KEEP_SECOND' }, ctx)).wait(ctx);
  const initial = (await f.harness.snapshot(AssistantPeers, ctx))!, first = Object.values(initial.work)[0]!, second = Object.values(initial.work)[1]!;
  const shown = assistantWorkView(initial, first.id)!;
  const stop = await stopAssistantWork(f.harness, first.id, shown.controlVersion, 'owner-stop-first', f.withControl, ctx);
  assert.equal(stop.stop?.confirmed, true); assert.equal(aborted, true);
  assert.equal((await f.harness.waitForTask(second.taskId, ctx)).state.outcome.status, 'completed'); await f.root.waitForIdle(ctx);
  assert.equal(effects, 1);
  const reports = (await f.root.context(ctx)).messages.filter(message => message.role === 'user' && String(message.content).startsWith('ASSISTANT_REPORT '));
  assert.equal(reports.length, 1); assert(String(reports[0]!.content).includes(second.id));
  await f.reopen();
  const replay = await stopAssistantWork(f.harness, first.id, shown.controlVersion, 'owner-stop-first', f.withControl, ctx); assert.equal(replay.stop?.confirmed, true);
  await (await f.root.submit({ type: 'input', content: 'RETRY_STOPPED' }, ctx)).wait(ctx);
  assert.equal(Object.keys((await f.harness.snapshot(AssistantPeers, ctx))!.work).length, 2); assert.equal(effects, 1);
});

test('stopping only a queued assignment never interrupts the peer current work or invokes the queued model', async t => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); let roleId = '', forbidden = 0;
  const hold = defineTool({ name: 'hold', description: 'Keep the first work running.', parameters: Type.Object({}), replay: 'safe', execute: async () => {
    entered.resolve(); await release.promise; return { output: [] };
  } });
  t.after(() => release.resolve());
  const f = await fixture(t, context => {
    const last = context.messages.filter(message => message.role === 'user').at(-1)?.content;
    if (!hasTool(context, 'task_submit')) {
      if (last === 'CANCEL_QUEUED') { forbidden++; return fauxAssistantMessage('Queued work must not run.'); }
      return context.messages.some(message => message.role === 'toolResult' && message.toolName === 'hold') ? fauxAssistantMessage('FIRST_WORK_RETAINED_817') : call('hold', {});
    }
    const latest = context.messages.filter(message => message.role === 'user' || message.role === 'toolResult').at(-1)!;
    if (latest.role === 'user' && ['KEEP_FIRST', 'CANCEL_QUEUED'].includes(String(last))) return call('assistant_assign', { assistant: { id: roleId, revision: 1 }, instructions: String(last) });
    return fauxAssistantMessage('Original state retained.');
  }, [defineExtension({ name: 'peer_stop_queued', tools: [hold] })]);
  roleId = (await f.roles.create({ workspace: f.workspace.root, name: 'Queued stop', instructions: 'Keep original work.', tools: ['hold'] })).id;
  await (await f.root.submit({ type: 'input', content: 'KEEP_FIRST' }, ctx)).wait(ctx); await entered.promise;
  await (await f.root.submit({ type: 'input', content: 'CANCEL_QUEUED' }, ctx)).wait(ctx);
  const initial = (await f.harness.snapshot(AssistantPeers, ctx))!, first = Object.values(initial.work)[0]!, second = Object.values(initial.work)[1]!;
  const shown = assistantWorkView(initial, second.id)!;
  const stopped = await stopAssistantWork(f.harness, second.id, shown.controlVersion, 'stop-queued-only', f.withControl, ctx);
  assert.equal(stopped.stop?.confirmed, true); assert.equal(forbidden, 0);
  assert.equal((await f.harness.getTask(first.taskId, ctx))!.state.status, 'running');
  release.resolve(); assert.equal((await f.harness.waitForTask(first.taskId, ctx)).state.outcome.status, 'completed'); await f.root.waitForIdle(ctx);
  assert.equal(forbidden, 0);
  const reports = (await f.root.context(ctx)).messages.filter(message => message.role === 'user' && String(message.content).startsWith('ASSISTANT_REPORT '));
  assert.equal(reports.length, 1); assert(String(reports[0]!.content).includes(first.id));
});

test('stopping a nested original assignment confirms its subtree and leaves a separate peer working', async t => {
  let parentId = '', childId = '', otherId = '', ended = 0;
  const entered = Promise.withResolvers<void>(), releaseOther = Promise.withResolvers<void>();
  const hold = defineTool({ name: 'hold', description: 'Hold the nested worker until stop.', parameters: Type.Object({}), replay: 'safe', execute: async (_args, _api, context) => {
    entered.resolve(); const signal = context.abortSignal; assert(signal);
    await new Promise<void>(resolve => signal.addEventListener('abort', () => { ended++; resolve(); }, { once: true })); return { output: [] };
  } });
  const other = defineTool({ name: 'other_hold', description: 'Keep another peer independent.', parameters: Type.Object({}), replay: 'safe', execute: async () => {
    await releaseOther.promise; return { output: [] };
  } });
  t.after(() => releaseOther.resolve());
  const f = await fixture(t, context => {
    const system = JSON.stringify(context.messages.filter(message => message.role === 'system'));
    const results = context.messages.filter(message => message.role === 'toolResult');
    if (system.includes('STOP_NESTED_CHILD_318')) return call('hold', {});
    if (system.includes('KEEP_OTHER_PEER_714')) return results.some(result => result.toolName === 'other_hold') ? fauxAssistantMessage('INDEPENDENT_PEER_RESULT_862') : call('other_hold', {});
    if (system.includes('STOP_NESTED_PARENT_529')) return results.some(result => result.toolName === 'assistant_assign') ? fauxAssistantMessage('Waiting for nested evidence.') :
      call('assistant_assign', { assistant: { id: childId, revision: 1 }, instructions: 'Wait for stop.' });
    const last = context.messages.filter(message => message.role === 'user' || message.role === 'toolResult').at(-1)!;
    if (last.role === 'user' && last.content === 'PARENT') return call('assistant_assign', { assistant: { id: parentId, revision: 1 }, instructions: 'Coordinate original nested work.' });
    if (last.role === 'user' && last.content === 'OTHER') return call('assistant_assign', { assistant: { id: otherId, revision: 1 }, instructions: 'Keep independent work.' });
    return fauxAssistantMessage('Original root retained.');
  }, [defineExtension({ name: 'peer_stop_nested', tools: [hold, other] })]);
  parentId = (await f.roles.create({ workspace: f.workspace.root, name: 'Stop nested parent', instructions: 'STOP_NESTED_PARENT_529', tools: ['assistant_assign', 'hold'] })).id;
  childId = (await f.roles.create({ workspace: f.workspace.root, name: 'Stop nested child', instructions: 'STOP_NESTED_CHILD_318', tools: ['hold'] })).id;
  otherId = (await f.roles.create({ workspace: f.workspace.root, name: 'Keep other', instructions: 'KEEP_OTHER_PEER_714', tools: ['other_hold'] })).id;
  await (await f.root.submit({ type: 'input', content: 'PARENT' }, ctx)).wait(ctx); await entered.promise;
  await (await f.root.submit({ type: 'input', content: 'OTHER' }, ctx)).wait(ctx);
  const initial = (await f.harness.snapshot(AssistantPeers, ctx))!, parent = Object.values(initial.work).find(work => work.assistant.id === parentId)!;
  const separate = Object.values(initial.work).find(work => work.assistant.id === otherId)!;
  const stopped = await stopAssistantWork(f.harness, parent.id, assistantWorkView(initial, parent.id)!.controlVersion, 'stop-nested-subtree', f.withControl, ctx);
  assert.equal(stopped.stop?.confirmed, true); assert.equal(ended, 1);
  const state = (await f.harness.snapshot(AssistantPeers, ctx))!; assert(Object.values(state.work).filter(work => work.assistant.id !== otherId).every(work => work.stop?.confirmed));
  releaseOther.resolve(); assert.equal((await f.harness.waitForTask(separate.taskId, ctx)).state.outcome.status, 'completed'); await f.root.waitForIdle(ctx);
  const reports = (await f.root.context(ctx)).messages.filter(message => message.role === 'user' && String(message.content).startsWith('ASSISTANT_REPORT '));
  assert.equal(reports.length, 1); assert(String(reports[0]!.content).includes(separate.id));
});

test('a stop confirms while the source is disabled without waking its queued sibling until the original host permits work', async t => {
  const entered = Promise.withResolvers<void>(); let roleId = '', calls = 0;
  const hold = defineTool({ name: 'hold', description: 'Hold original work until stop.', parameters: Type.Object({}), replay: 'safe', execute: async (_args, _api, context) => {
    const signal = context.abortSignal; assert(signal); entered.resolve();
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); return { output: [] };
  } });
  const f = await fixture(t, context => {
    const last = context.messages.filter(message => message.role === 'user').at(-1)?.content;
    if (!hasTool(context, 'task_submit')) {
      if (last === 'FIRST') return call('hold', {});
      calls++; return fauxAssistantMessage('QUEUED_AFTER_HOST_RESUME_714');
    }
    const latest = context.messages.filter(message => message.role === 'user' || message.role === 'toolResult').at(-1)!;
    if (latest.role === 'user' && ['FIRST', 'SECOND'].includes(String(last))) return call('assistant_assign', { assistant: { id: roleId, revision: 1 }, instructions: String(last) });
    return fauxAssistantMessage('Original state retained.');
  }, [defineExtension({ name: 'peer_disabled_stop', tools: [hold] })]);
  roleId = (await f.roles.create({ workspace: f.workspace.root, name: 'Disabled source stop', instructions: 'Keep original work.', tools: ['hold'] })).id;
  await (await f.root.submit({ type: 'input', content: 'FIRST' }, ctx)).wait(ctx); await entered.promise;
  await (await f.root.submit({ type: 'input', content: 'SECOND' }, ctx)).wait(ctx);
  await until(() => f.harness.inspect(ctx), state => state.submissions.filter(input => input.conversationId !== f.root.id).length === 2);
  const initial = (await f.harness.snapshot(AssistantPeers, ctx))!, first = Object.values(initial.work)[0]!, second = Object.values(initial.work)[1]!;
  const shown = assistantWorkView(initial, first.id)!; f.enabled(false);
  const stop = await stopAssistantWork(f.harness, first.id, shown.controlVersion, 'stop-without-resuming', f.withControl, ctx); assert.equal(stop.stop?.confirmed, true);
  const pending = await f.harness.commit(tx => tx.submissionByRequest(second.target, second.messageRequestId), ctx);
  assert.equal(pending?.status, 'queued'); assert.equal(calls, 0);
  f.enabled(true); await stopAssistantWork(f.harness, first.id, shown.controlVersion, 'stop-without-resuming', f.withControl, ctx);
  await f.harness.waitForTask(second.taskId, ctx); await f.root.waitForIdle(ctx); assert.equal(calls, 1);
});

test('a dispatched peer receives fixed binary and empty inputs in its original work copies and rework keeps old bytes', async t => {
  let roleId = '', workId = '', rounds = 0;
  const f = await fixture(t, context => {
    if (!hasTool(context, 'task_submit')) {
      const latest = context.messages.filter(message => message.role === 'user').at(-1)?.content; assert.equal(typeof latest, 'string');
      const lines = String(latest).split('ASSISTANT_INPUT_FILES '); assert.equal(lines.length, 2);
      const files = JSON.parse(lines[1]!); assert.equal(files.length, 2); assert(files.every((file: { path: string }) => file.path.includes('assistant-work')));
      rounds++; return fauxAssistantMessage('INPUT_HASHES_PINNED_817');
    }
    const last = context.messages.filter(message => message.role === 'user' || message.role === 'toolResult').at(-1)!;
    if (last.role === 'user' && last.content === 'FIRST_FILES') return call('assistant_assign', { assistant: { id: roleId, revision: 1 }, instructions: 'Inspect the fixed inputs.', files: ['original.bin', 'empty.txt'] });
    if (last.role === 'user' && last.content === 'REWORK_FILES') return call('assistant_rework', { id: workId, instructions: 'Recheck the original input bytes.' });
    return fauxAssistantMessage('Original file receipts retained.');
  });
  await writeFile(join(f.workspace.root, 'original.bin'), Buffer.from([0, 255, 128])); await writeFile(join(f.workspace.root, 'empty.txt'), '');
  roleId = (await f.roles.create({ workspace: f.workspace.root, name: 'Input worker', instructions: 'Use the fixed input copies.', tools: ['read'] })).id;
  await (await f.root.submit({ type: 'input', content: 'FIRST_FILES' }, ctx)).wait(ctx);
  const first = Object.values((await f.harness.snapshot(AssistantPeers, ctx))!.work)[0]!; workId = first.id;
  await f.harness.waitForTask(first.taskId, ctx); await f.root.waitForIdle(ctx); assert.equal(first.files.length, 2);
  assert.deepEqual(await readFile(first.files[0]!.path), Buffer.from([0, 255, 128])); assert.equal((await readFile(first.files[1]!.path)).length, 0);
  await writeFile(join(f.workspace.root, 'original.bin'), 'Later version'); await f.reopen();
  await (await f.root.submit({ type: 'input', content: 'REWORK_FILES' }, ctx)).wait(ctx);
  const revised = Object.values((await f.harness.snapshot(AssistantPeers, ctx))!.work).at(-1)!;
  await f.harness.waitForTask(revised.taskId, ctx); await f.root.waitForIdle(ctx); assert.equal(rounds, 2);
  assert.equal(revised.reworkOf, first.id); assert.notEqual(revised.files[0]!.path, first.files[0]!.path);
  assert.deepEqual(await readFile(revised.files[0]!.path), Buffer.from([0, 255, 128])); assert.equal(revised.files[0]!.sha256, first.files[0]!.sha256);
});

test('peer file attachments return fixed copies with their original result and never grant the source another tool', async t => {
  let roleId = '', outputs: { path: string; sha256: string; bytes: number }[] = [];
  const f = await fixture(t, context => {
    const results = context.messages.filter((message): message is ToolResultMessage => message.role === 'toolResult');
    if (!hasTool(context, 'task_submit')) {
      if (!results.some(result => result.toolName === 'assistant_attach')) return call('assistant_attach', { files: ['peer-output.bin', 'peer-empty.txt'] });
      const attached = value(results.find(result => result.toolName === 'assistant_attach')!); outputs = attached.files;
      assert.equal(outputs.length, 2); return fauxAssistantMessage('ORIGINAL_RETURNED_FILES_928');
    }
    const last = context.messages.filter(message => message.role === 'user').at(-1)?.content;
    if (typeof last === 'string' && last.startsWith('ASSISTANT_REPORT ')) {
      const report = JSON.parse(last.slice('ASSISTANT_REPORT '.length)); assert.equal(report.outputs.length, 2);
      assert.equal(report.outputs[0].sha256, outputs[0]!.sha256); return fauxAssistantMessage('Original file results read.');
    }
    if (!results.some(result => result.toolName === 'assistant_assign')) return call('assistant_assign', { assistant: { id: roleId, revision: 1 }, instructions: 'Return the original binary evidence.' });
    return fauxAssistantMessage('Original result pending.');
  });
  await writeFile(join(f.workspace.root, 'peer-output.bin'), Buffer.from([0, 255, 17])); await writeFile(join(f.workspace.root, 'peer-empty.txt'), '');
  roleId = (await f.roles.create({ workspace: f.workspace.root, name: 'File return worker', instructions: 'Attach actual result files.', tools: ['assistant_attach'] })).id;
  await (await f.root.submit({ type: 'input', content: 'Return actual original files.' }, ctx)).wait(ctx);
  const work = Object.values((await f.harness.snapshot(AssistantPeers, ctx))!.work)[0]!;
  assert.equal((await f.harness.waitForTask(work.taskId, ctx)).state.outcome.status, 'completed'); await f.root.waitForIdle(ctx);
  assert.equal(outputs.length, 2); assert.deepEqual(await readFile(outputs[0]!.path), Buffer.from([0, 255, 17])); assert.equal((await readFile(outputs[1]!.path)).length, 0);
  await writeFile(join(f.workspace.root, 'peer-output.bin'), 'Later peer edit');
  assert.deepEqual(await readFile(outputs[0]!.path), Buffer.from([0, 255, 17]));
  assert.equal(assistantWorkView(await f.harness.snapshot(AssistantPeers, ctx), work.id)!.outputs.length, 2);
});

test('rework refuses a modified original input copy instead of accepting it as the old evidence', async t => {
  let roleId = '', workId = '', rounds = 0;
  const f = await fixture(t, context => {
    if (!hasTool(context, 'task_submit')) { rounds++; return fauxAssistantMessage('Original evidence seen.'); }
    const latest = context.messages.filter(message => message.role === 'user' || message.role === 'toolResult').at(-1)!;
    if (latest.role === 'user' && latest.content === 'FIRST') return call('assistant_assign', { assistant: { id: roleId, revision: 1 }, instructions: 'Inspect original.', files: ['seed.txt'] });
    if (latest.role === 'user' && latest.content === 'REWORK') return call('assistant_rework', { id: workId, instructions: 'Recheck original.' });
    if (latest.role === 'toolResult' && latest.toolName === 'assistant_rework') assert.equal(latest.isError, true);
    return fauxAssistantMessage('Original receipt retained.');
  });
  await writeFile(join(f.workspace.root, 'seed.txt'), 'Original seed');
  roleId = (await f.roles.create({ workspace: f.workspace.root, name: 'Changed copy', instructions: 'Keep fixed evidence.', tools: ['read'] })).id;
  await (await f.root.submit({ type: 'input', content: 'FIRST' }, ctx)).wait(ctx);
  const first = Object.values((await f.harness.snapshot(AssistantPeers, ctx))!.work)[0]!; workId = first.id;
  await f.harness.waitForTask(first.taskId, ctx); await f.root.waitForIdle(ctx);
  await writeFile(first.files[0]!.path, 'Modified fixed input');
  await (await f.root.submit({ type: 'input', content: 'REWORK' }, ctx)).wait(ctx);
  assert.equal(rounds, 1); assert.equal(Object.keys((await f.harness.snapshot(AssistantPeers, ctx))!.work).length, 1);
});

test('recipient prompts exclude source-private memory and preparation sections even if the host supplied those extensions', async t => {
  let roleId = '', peerCalls = 0;
  const extras = ['local_user_memory', 'local_preparation', 'local_verification', 'local_learning'].map(name => defineExtension({ name,
    sections: [section(name + '_source_private', () => 'PRIVATE_SOURCE_SECTION_918')] }));
  const f = await fixture(t, context => {
    const text = JSON.stringify(context.messages);
    if (!hasTool(context, 'task_submit')) { peerCalls++; assert(!text.includes('PRIVATE_SOURCE_SECTION_918')); return fauxAssistantMessage('Only original assignment context.'); }
    assert(text.includes('PRIVATE_SOURCE_SECTION_918'));
    if (!context.messages.some(message => message.role === 'toolResult' && message.toolName === 'assistant_assign')) return call('assistant_assign', { assistant: { id: roleId, revision: 1 }, instructions: 'Read only assigned context.' });
    return fauxAssistantMessage('Original privacy retained.');
  }, extras);
  roleId = (await f.roles.create({ workspace: f.workspace.root, name: 'Private context recipient', instructions: 'Keep assigned context.', tools: ['read'] })).id;
  await (await f.root.submit({ type: 'input', content: 'Keep source context private.' }, ctx)).wait(ctx);
  const work = Object.values((await f.harness.snapshot(AssistantPeers, ctx))!.work)[0]!;
  await f.harness.waitForTask(work.taskId, ctx); await f.root.waitForIdle(ctx); assert.equal(peerCalls, 1);
  assert.equal((await f.harness.snapshot(AssistantPeers, ctx))!.work[work.id]!.result?.status, 'done');
});
