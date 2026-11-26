import assert from 'node:assert/strict';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from '@earendil-works/pi-ai';
import { createRegistry, defineExtension, defineTool, Harness, hook, ToolTask, type Conversation } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { Assistants } from '../../src/assistants.js';
import { AssistantPeers } from '../../src/assistant-peer-state.js';
import { assistantPeersExtension } from '../../src/assistant-peers.js';
import { localEnvironment, localExecution } from '../../src/execution.js';
import { GoalDoc, goalExtension } from '../../src/goal.js';
import { SerialQueue } from '../../src/util.js';
import { Workspace } from '../../src/workspace.js';
import { hasTool } from '../helpers.js';

const [phase, directory, stage] = process.argv.slice(2) as [string, string, string];
const path = join(directory, 'workspace'), statePath = join(directory, 'fixture.json');
if (phase === 'create') await mkdir(path);
const workspace = await Workspace.open(path), models = createModels(), queue = new SerialQueue();
const model = { provider: 'peer-recovery', modelId: 'original' }, provider = fauxProvider({ provider: model.provider, models: [{ id: model.modelId }] });
const roles = new Assistants(directory, models);
let roleId = phase === 'recover' ? (JSON.parse(await readFile(statePath, 'utf8')) as { roleId: string }).roleId : '';
const ready = async () => { console.log(JSON.stringify({ type: 'ready', stage })); await setTimeout(60_000); };
provider.setResponses(Array.from({ length: 20 }, () => async context => {
  const results = context.messages.filter(message => message.role === 'toolResult');
  if (!hasTool(context, 'task_submit')) {
    const text = JSON.stringify(context.messages); assert(text.includes('ORIGINAL_PEER_RECOVERY_814')); assert(!text.includes('CHANGED_PEER_RECOVERY_392')); assert(!hasTool(context, 'write'));
    if (phase === 'create' && stage === 'assignment-before-receipt') await setTimeout(60_000);
    return results.some(result => result.toolName === 'peer_effect') ? fauxAssistantMessage('ORIGINAL_NATIVE_RESULT_817') :
      fauxAssistantMessage(fauxToolCall('peer_effect', {}), { stopReason: 'toolUse' });
  }
  const last = context.messages.filter(message => message.role === 'user').at(-1)?.content;
  if (typeof last === 'string' && last.startsWith('ASSISTANT_REPORT ')) return fauxAssistantMessage('Original result receipt acknowledged.');
  return results.some(result => result.toolName === 'assistant_assign') ? fauxAssistantMessage('Original assignment acknowledged.') :
    fauxAssistantMessage(fauxToolCall('assistant_assign', { assistant: { id: roleId, revision: 1 }, instructions: 'Perform the original effect once.' }), { stopReason: 'toolUse' });
})); models.setProvider(provider.provider);
const effect = defineExtension({ name: 'peer_recovery_effect', tools: [defineTool({ name: 'peer_effect', description: 'An external effect with an uncertain crash receipt.',
  parameters: Type.Object({}), execute: async () => {
    await appendFile(join(directory, 'effects.txt'), 'original-effect\n');
    if (phase === 'create' && stage === 'effect-before-receipt') await ready();
    return { output: [{ type: 'text', text: 'Original effect receipt.' }] };
  } })] });
const barrier = defineExtension({ name: 'peer_recovery_barrier', hooks: [hook(ToolTask, { async afterTool(call) {
  if (phase === 'create' && stage === 'assignment-before-receipt' && call.name === 'assistant_assign') await ready();
} })] });
let root: Conversation;
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
    roleId = (await roles.create({ workspace: path, name: 'Original worker', instructions: 'ORIGINAL_PEER_RECOVERY_814', tools: ['peer_effect'] })).id;
    await writeFile(statePath, JSON.stringify({ roleId }));
    await harness.commit(async tx => Object.assign(await tx.doc(GoalDoc), { initialized: true, phase: 'working', objective: 'Private source goal.' }), ctx);
    await root.submit({ type: 'input', content: 'START', requestId: 'original-start' }, ctx);
    await setTimeout(60_000);
  } else {
    await roles.update(roleId, { revision: 1, instructions: 'CHANGED_PEER_RECOVERY_392', tools: ['peer_effect', 'write'], archived: true });
    harness.resume();
    const initial = (await harness.snapshot(AssistantPeers, ctx))!;
    for (const work of Object.values(initial.work)) assert.equal((await harness.waitForTask(work.taskId, ctx)).state.outcome.status, 'completed');
    await root.waitForIdle(ctx);
    const state = (await harness.snapshot(AssistantPeers, ctx))!, work = Object.values(state.work)[0]!;
    const peerInputs = await storage.scanSubmissions({ conversationId: work.target }, 100, undefined, ctx);
    const reports = (await root.context(ctx)).messages.filter(message => message.role === 'user' && String(message.content).startsWith('ASSISTANT_REPORT '));
    console.log(JSON.stringify({ type: 'completed', workCount: Object.keys(state.work).length, seatCount: Object.keys(state.seats).length,
      peerInputs: peerInputs.items.length, reports: reports.length, originalRevision: state.seats[String(work.target)]!.pin.revision,
      latestRevision: (await roles.get(roleId)).revision, effects: await readFile(join(directory, 'effects.txt'), 'utf8'), result: work.result?.status }));
  }
} finally { await harness.close(ctx); }
