import assert from 'node:assert/strict';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from '@earendil-works/pi-ai';
import { createRegistry, defineExtension, defineTool, Harness, hook, ToolTask, type Conversation } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { Assistants } from '../../src/assistants.js';
import { AssistantPeers, assistantWorkView, requestAssistantStop } from '../../src/assistant-peer-state.js';
import { assistantPeersExtension, stopAssistantWork, type AssistantPeerControl } from '../../src/assistant-peers.js';
import { localEnvironment, localExecution } from '../../src/execution.js';
import { GoalDoc, goalExtension } from '../../src/goal.js';
import { SerialQueue } from '../../src/util.js';
import { Workspace } from '../../src/workspace.js';
import { hasTool, until } from '../helpers.js';

const [phase, directory, stage] = process.argv.slice(2) as [string, string, string];
const path = join(directory, 'workspace'), statePath = join(directory, 'fixture.json');
if (phase === 'create') await mkdir(path);
const workspace = await Workspace.open(path), models = createModels(), queue = new SerialQueue();
const model = { provider: 'peer-recovery', modelId: 'original' }, provider = fauxProvider({ provider: model.provider, models: [{ id: model.modelId }] });
const roles = new Assistants(directory, models);
let roleId = phase === 'recover' ? (JSON.parse(await readFile(statePath, 'utf8')) as { roleId: string }).roleId : '';
const ready = async () => { console.log(JSON.stringify({ type: 'ready', stage })); await setTimeout(60_000); };
const stopCase = stage === 'stop-requested' || stage === 'stop-confirmed-before-boundary';
const inputCase = stage === 'input-copies-before-claim', outputCase = stage === 'output-copies-before-receipt';
const held = Promise.withResolvers<void>();
const inspect = workspace.inspect.bind(workspace);
workspace.inspect = async (...args) => {
  const file = await inspect(...args);
  if (phase === 'create' && (inputCase && file.path.includes(join('assistant-work')) && file.path.includes(join('inputs')) ||
    outputCase && file.path.includes(join('assistant-work')) && file.path.includes(join('outputs')))) await ready();
  return file;
};
provider.setResponses(Array.from({ length: 20 }, () => async context => {
  const results = context.messages.filter(message => message.role === 'toolResult');
  if (!hasTool(context, 'task_submit')) {
    const text = JSON.stringify(context.messages); assert(text.includes('ORIGINAL_PEER_RECOVERY_814')); assert(!text.includes('CHANGED_PEER_RECOVERY_392')); assert(!hasTool(context, 'write'));
    const last = context.messages.filter(message => message.role === 'user').at(-1)?.content;
    if (stopCase && last === 'CANCEL_ORIGINAL') return fauxAssistantMessage(fauxToolCall('peer_hold', {}), { stopReason: 'toolUse' });
    if (outputCase && !results.some(result => result.toolName === 'assistant_attach')) return fauxAssistantMessage(fauxToolCall('assistant_attach', { files: ['output.bin'] }), { stopReason: 'toolUse' });
    if (phase === 'create' && stage === 'assignment-before-receipt') await setTimeout(60_000);
    return results.some(result => result.toolName === 'peer_effect') ? fauxAssistantMessage('ORIGINAL_NATIVE_RESULT_817') :
      fauxAssistantMessage(fauxToolCall('peer_effect', {}), { stopReason: 'toolUse' });
  }
  const last = context.messages.filter(message => message.role === 'user').at(-1)?.content;
  if (typeof last === 'string' && last.startsWith('ASSISTANT_REPORT ')) return fauxAssistantMessage('Original result receipt acknowledged.');
  const latest = context.messages.filter(message => message.role === 'user' || message.role === 'toolResult').at(-1)!;
  return latest.role !== 'user' ? fauxAssistantMessage('Original assignment acknowledged.') :
    fauxAssistantMessage(fauxToolCall('assistant_assign', { assistant: { id: roleId, revision: 1 }, instructions: stopCase ? String(last) : 'Perform the original effect once.',
      ...(inputCase ? { files: ['input.bin'] } : {}) }), { stopReason: 'toolUse' });
})); models.setProvider(provider.provider);
const effect = defineExtension({ name: 'peer_recovery_effect', tools: [defineTool({ name: 'peer_effect', description: 'An external effect with an uncertain crash receipt.',
  parameters: Type.Object({}), execute: async () => {
    await appendFile(join(directory, 'effects.txt'), 'original-effect\n');
    if (phase === 'create' && stage === 'effect-before-receipt') await ready();
    return { output: [{ type: 'text', text: 'Original effect receipt.' }] };
  } }), defineTool({ name: 'peer_hold', description: 'Hold only the original stopped work.', parameters: Type.Object({}), replay: 'safe', execute: async (_args, _api, context) => {
    if (phase === 'recover') throw new Error('Stopped work must never restart its held tool.');
    held.resolve(); const signal = context.abortSignal; assert(signal);
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); return { output: [] };
  } })] });
const barrier = defineExtension({ name: 'peer_recovery_barrier', hooks: [hook(ToolTask, { async afterTool(call) {
  if (phase === 'create' && stage === 'assignment-before-receipt' && call.name === 'assistant_assign') await ready();
} })] });
let root: Conversation;
const withControl = <T>(action: (control: AssistantPeerControl) => Promise<T>) => queue.run(async () => action({ root: root.id, project: path, enabled: true, requiresConfirmation: false, deadlineAt: Number.MAX_SAFE_INTEGER }));
const coding = localExecution(), goal = goalExtension({ assistantPeers: true });
const extension = assistantPeersExtension({ roles, workspace, models, defaultModel: model, maxPeers: 2, extensions: () => [coding, effect],
  withControl: action => queue.run(async () => {
    const result = await action({ root: root.id, project: path, enabled: true, requiresConfirmation: false, deadlineAt: Number.MAX_SAFE_INTEGER });
    if (phase === 'create' && stage === 'report-before-receipt') {
      const posted = await harness.commit(async tx => {
        const state = await tx.doc(AssistantPeers);
        for (const work of Object.values(state.work)) if (await tx.submissionByRequest(root.id, work.reportRequestId)) return true;
        return false;
      }, ctx);
      if (posted) await ready();
    }
    return result;
  }) });
const registry = createRegistry(); for (const item of [coding, goal, extension, effect, barrier]) registry.install(item);
const storage = await openNodeSqliteStorage(join(directory, 'session.sqlite'));
const harness = await Harness.open(storage, { models, registry, env: ({ cwd }) => localEnvironment(cwd ?? path) }, ctx);
try {
  root = await harness.root(ctx, { agent: { model, cwd: path, extensions: [coding, goal, extension, effect, barrier] } });
  if (phase === 'create') {
    roleId = (await roles.create({ workspace: path, name: 'Original worker', instructions: 'ORIGINAL_PEER_RECOVERY_814', tools: stopCase ? ['peer_effect', 'peer_hold'] : outputCase ? ['peer_effect', 'assistant_attach'] : ['peer_effect'] })).id;
    if (inputCase) await writeFile(join(path, 'input.bin'), Buffer.from([0, 255, 128]));
    if (outputCase) await writeFile(join(path, 'output.bin'), Buffer.from([0, 255, 17]));
    await writeFile(statePath, JSON.stringify({ roleId }));
    await harness.commit(async tx => Object.assign(await tx.doc(GoalDoc), { initialized: true, phase: 'working', objective: 'Private source goal.' }), ctx);
    if (stopCase) {
      await (await root.submit({ type: 'input', content: 'CANCEL_ORIGINAL', requestId: 'original-start' }, ctx)).wait(ctx); await held.promise;
      await (await root.submit({ type: 'input', content: 'KEEP_QUEUED', requestId: 'original-second' }, ctx)).wait(ctx);
      const work = Object.values((await harness.snapshot(AssistantPeers, ctx))!.work)[0]!;
      await until(() => harness.inspect(ctx), state => state.submissions.filter(input => input.conversationId !== root.id).length === 2);
      const version = assistantWorkView((await harness.snapshot(AssistantPeers, ctx))!, work.id)!.controlVersion;
      await writeFile(join(directory, 'stop.json'), JSON.stringify({ id: work.id, version }));
      if (stage === 'stop-requested') {
        await withControl(control => harness.commit(tx => requestAssistantStop(tx, control.root, work.id, version, 'original-owner-stop', Date.now()), ctx)); await ready();
      } else {
        const submit = harness.conversation.bind(harness);
        harness.conversation = async (id, context) => {
          const conversation = await submit(id, context);
          if (!conversation) return;
          const admit = conversation.submit.bind(conversation);
          conversation.submit = async (draft, inputContext) => { if (draft.type === 'write' && draft.requestId?.startsWith('assistant-stop-boundary:')) await ready(); return admit(draft, inputContext); };
          return conversation;
        };
        await stopAssistantWork(harness, work.id, version, 'original-owner-stop', withControl, ctx);
      }
    } else await root.submit({ type: 'input', content: 'START', requestId: 'original-start' }, ctx);
    await setTimeout(60_000);
  } else {
    await roles.update(roleId, { revision: 1, instructions: 'CHANGED_PEER_RECOVERY_392', tools: ['peer_effect', 'write'], archived: true });
    if (inputCase) await writeFile(join(path, 'input.bin'), 'Later source input');
    if (outputCase) await writeFile(join(path, 'output.bin'), 'Later source output');
    if (stopCase) {
      const saved = JSON.parse(await readFile(join(directory, 'stop.json'), 'utf8')) as { id: string; version: string };
      await stopAssistantWork(harness, saved.id, saved.version, 'original-owner-stop', withControl, ctx);
    }
    harness.resume();
    const initial = await until(() => harness.snapshot(AssistantPeers, ctx), state => Object.keys(state?.work ?? {}).length > 0); assert(initial);
    for (const work of Object.values(initial.work)) {
      const outcome = (await harness.waitForTask(work.taskId, ctx)).state.outcome.status;
      assert(work.stop ? outcome === 'aborted' || outcome === 'completed' : outcome === 'completed');
    }
    await root.waitForIdle(ctx);
    const state = (await harness.snapshot(AssistantPeers, ctx))!, work = Object.values(state.work)[0]!;
    const peerInputs = await storage.scanSubmissions({ conversationId: work.target }, 100, undefined, ctx);
    const reports = (await root.context(ctx)).messages.filter(message => message.role === 'user' && String(message.content).startsWith('ASSISTANT_REPORT '));
    console.log(JSON.stringify({ type: 'completed', workCount: Object.keys(state.work).length, seatCount: Object.keys(state.seats).length,
      peerInputs: peerInputs.items.filter(input => input.type === 'input').length, reports: reports.length, originalRevision: state.seats[String(work.target)]!.pin.revision,
      latestRevision: (await roles.get(roleId)).revision, effects: await readFile(join(directory, 'effects.txt'), 'utf8'), result: work.result?.status,
      stopped: Object.values(state.work).filter(item => item.stop?.confirmed).length, queuedDone: Object.values(state.work).filter(item => !item.stop && item.result?.status === 'done').length,
      inputsKept: inputCase ? (await readFile(work.files[0]!.path)).equals(Buffer.from([0, 255, 128])) : null,
      outputsKept: outputCase ? (await readFile(work.outputs![0]!.path)).equals(Buffer.from([0, 255, 17])) : null }));
  }
} finally { await harness.close(ctx); }
