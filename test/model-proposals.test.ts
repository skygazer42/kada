import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { ChatSession } from '../src/chat.js';
import { createClient } from '../src/client.js';
import { cloudModels } from '../src/models.js';
import { ProviderSettings } from '../src/provider-settings.js';
import { serve } from '../src/server.js';
import { hasTool, recoveryTestTimeoutMs, scriptedFixture, startRecoveryWorker, until } from './helpers.js';

test('a saved model proposal applies once with a fresh check, preserving its original project and baseline', async t => {
  const root = await mkdtemp(join(tmpdir(), 'kada-model-proposal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const a = join(root, 'a'), b = join(root, 'b');
  await Promise.all([mkdir(a), mkdir(b)]);
  const base = { provider: 'siliconflow', modelId: 'Qwen/Qwen2.5-7B-Instruct' };
  const candidate = { provider: 'siliconflow', modelId: 'deepseek-ai/DeepSeek-V3.2' };
  let checks = 0, unavailable = true;
  const open = () => new ProviderSettings(root, cloudModels(), async () => {
    checks++;
    return unavailable ? { status: 'unavailable', code: 'auth' } : { status: 'available' };
  });
  const first = open();
  const proposed = await first.propose(a, 'source', '17', candidate, '适合项目文本。', base);
  assert.equal(proposed.state, 'pending');
  assert.deepEqual(proposed.previous, base);
  assert.deepEqual(await first.selected(base, a), base);
  assert.equal(checks, 0);
  const reopened = open();
  assert.deepEqual(await reopened.propose(a, 'source', '17', candidate, '适合项目文本。', base), proposed);
  await assert.rejects(reopened.propose(a, 'source', '17', base, 'Different choice.', base), /different content/i);
  await assert.rejects(reopened.decideProposal(b, 'source', '17', 'apply', base), /not found/i);
  await assert.rejects(reopened.decideProposal(a, 'another-source', '17', 'apply', base), /not found/i);
  await assert.rejects(reopened.decideProposal(a, 'source', '17', 'apply', base), /rejected/i);
  assert.equal(checks, 1);
  assert.deepEqual(await reopened.selected(base, a), base);
  assert.equal((await reopened.proposals(a, 'source'))[0]?.state, 'pending');
  unavailable = false;
  const responses = await Promise.all([reopened.decideProposal(a, 'source', '17', 'apply', base), reopened.decideProposal(a, 'source', '17', 'apply', base)]);
  assert.deepEqual(responses[0], responses[1]);
  assert.equal(responses[0].state, 'applied');
  assert.equal(checks, 2);
  assert.deepEqual(await reopened.selected(base, a), candidate);
  assert.deepEqual(await reopened.selected(base, b), base);
  await assert.rejects(reopened.decideProposal(a, 'source', '17', 'decline', base), /already/i);
  const other = await reopened.propose(a, 'source', '18', base, '新的项目设置。', base);
  assert.deepEqual(other.previous, candidate);
  await reopened.clear(a);
  await assert.rejects(reopened.decideProposal(a, 'source', '18', 'apply', base), /default.*changed/i);
  assert.equal(checks, 2);
  assert.equal((await reopened.decideProposal(a, 'source', '18', 'decline', base)).state, 'declined');
  const synthetic = 'sk-' + 'z'.repeat(28);
  const masked = await reopened.propose(a, 'source', '19', candidate, `Consider it for future tasks.\nToken: ${synthetic}`, base);
  assert(!masked.reason.includes(synthetic));
  await assert.rejects(reopened.propose(a, 'source', '20', { ...candidate, modelId: synthetic }, 'Unknown fixture.', base),
    error => error instanceof Error && !error.message.includes(synthetic) && /unknown model/i.test(error.message));
});

test('the original chat proposes a model, the owner applies after restart, and only new project chats adopt it', async t => {
  const next = { provider: 'proposal-target', modelId: 'fixture-model' };
  const f = await scriptedFixture(context => {
    const last = context.messages.findLast(message => message.role === 'user');
    if (last?.content === 'Remote test' || last?.content === 'Historical follow-up') {
      assert(!hasTool(context, 'propose_model'));
      return fauxAssistantMessage('Remote ready.');
    }
    if (last?.content === 'Suggest the new project model' && !context.messages.some(message => message.role === 'toolResult' && message.toolName === 'propose_model')) {
      assert(hasTool(context, 'propose_model'));
      return fauxAssistantMessage(fauxToolCall('propose_model', { ...next, reason: 'Use the selected fixture for future tasks.' }), { stopReason: 'toolUse' });
    }
    return fauxAssistantMessage('Ready.');
  });
  await f.runtime.close();
  let targetRequests = 0;
  const target = fauxProvider({ provider: next.provider, models: [{ id: next.modelId }] });
  target.setResponses(Array.from({ length: 5 }, () => () => { targetRequests++; return fauxAssistantMessage('Target model ready.'); }));
  f.models.setProvider(target.provider);
  const socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const settings = { ...f.settings, port };
  let daemon = await serve(settings, { models: f.models });
  t.after(async () => { await daemon.close(); await f.close(); });
  const client = createClient(settings), events: string[] = [];
  const terminal = new ChatSession(client, event => events.push(event.text), f.workspace);
  await terminal.handle('Suggest the new project model');
  const id = terminal.taskId!;
  const original = await until(() => daemon.runtime.status(id), state => state.status === 'answered');
  await terminal.poll();
  assert(events.some(text => text.includes('/model-proposals')));
  const [proposal] = await daemon.runtime.projectModelProposals(id);
  assert(proposal?.state === 'pending');
  assert.equal(targetRequests, 0);
  const path = '/v1/tasks/' + id + '/model-proposals';
  assert.equal((await fetch(`http://127.0.0.1:${port}${path}/${proposal.id}`, { method: 'POST', body: '{"decision":"apply"}' })).status, 401);
  const legacy = await daemon.runtime.create('Original historical chat.', f.workspace, [], { chat: true });
  await until(() => daemon.runtime.status(legacy.id), state => state.status === 'answered');
  const legacyMeta = await daemon.runtime.metadata(legacy.id);
  delete legacyMeta.modelProposals;
  await daemon.close();
  await writeFile(join(settings.dataDir, 'tasks', legacy.id, 'task.json'), JSON.stringify(legacyMeta));
  daemon = await serve(settings, { models: f.models });
  await daemon.runtime.followUp(legacy.id, 'Historical follow-up', 'model-proposal-legacy');
  await until(() => daemon.runtime.status(legacy.id), state => state.status === 'answered' && state.submission?.requestId === 'user:model-proposal-legacy');
  await assert.rejects(daemon.runtime.projectModelProposals(legacy.id), /no project model proposals/i);
  await terminal.attach(id);
  await terminal.handle('/model-proposals');
  assert(events.some(text => text.includes(`/apply-model ${proposal.id}`) && text.includes(next.modelId)));
  await terminal.handle('/apply-model ' + proposal.id);
  await terminal.handle('/apply-model ' + proposal.id);
  assert.equal(targetRequests, 1);
  assert.deepEqual((await daemon.runtime.status(id)).model, original.model);
  assert.equal((await daemon.runtime.projectModelProposals(id))[0]?.state, 'applied');
  const fresh = await daemon.runtime.create('Fresh local chat.', f.workspace, [], { chat: true });
  await until(() => daemon.runtime.status(fresh.id), state => state.status === 'answered');
  assert.deepEqual(fresh.model, next);
  const remote = await daemon.runtime.create('Remote test', f.workspace, [], { chat: true, remote: true });
  await until(() => daemon.runtime.status(remote.id), state => state.status === 'answered');
  await assert.rejects(daemon.runtime.projectModelProposals(remote.id), /no project model proposals/i);
  assert.equal(targetRequests, 2);
});

test('SIGKILL after applying retains the original approval receipt and a later choice', { timeout: recoveryTestTimeoutMs }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'kada-model-proposal-recovery-')));
  const fixture = new URL('./fixtures/model-proposal-worker.ts', import.meta.url);
  let worker = startRecoveryWorker(fixture, 'create', directory);
  try {
    const original = await worker.ready();
    assert.equal(await worker.stop(), 'SIGKILL');
    worker = startRecoveryWorker(fixture, 'recover', directory);
    const result = await worker.complete();
    assert.deepEqual(result.receipt, original.receipt);
    assert.equal(result.probes, 'target-probe\n');
    assert.deepEqual(result.selected, { provider: 'proposal-source', modelId: 'scripted' });
    assert.deepEqual(result.originalChatModel, result.selected);
  } finally { await worker.stop(); await rm(directory, { recursive: true, force: true, maxRetries: 5 }); }
});

test('applying a proposal rechecks the original default after the provider probe', async t => {
  const root = await mkdtemp(join(tmpdir(), 'kada-model-probe-race-'));
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  t.after(async () => { release.resolve(); await rm(root, { recursive: true, force: true }); });
  const a = join(root, 'a');
  await mkdir(a);
  const original = { provider: 'siliconflow', modelId: 'Qwen/Qwen2.5-7B-Instruct' };
  const next = { provider: 'siliconflow', modelId: 'deepseek-ai/DeepSeek-V3.2' };
  const settings = new ProviderSettings(root, cloudModels(), async model => {
    if (model.id === next.modelId) { started.resolve(); await release.promise; }
    return { status: 'available' };
  });
  await settings.propose(a, 'source', '91', next, 'Change the future model.', original);
  const applying = assert.rejects(settings.decideProposal(a, 'source', '91', 'apply', original), /default.*changed/i);
  await started.promise;
  await settings.check(original);
  await settings.select(original, a);
  release.resolve();
  await applying;
  assert.deepEqual(await settings.selected(undefined, a), original);
  assert.equal((await settings.proposals(a, 'source'))[0]?.state, 'pending');
});
