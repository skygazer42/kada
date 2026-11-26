import assert from 'node:assert/strict';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from '@earendil-works/pi-ai';
import { defineExtension, defineTool } from '@earendil-works/pi-durable';
import { AssistantPeers } from '../../src/assistant-peer-state.js';
import { LocalRuntime } from '../../src/runtime.js';
import { hasTool, until } from '../helpers.js';

const [phase, directory, stage] = process.argv.slice(2) as [string, string, string];
const workspace = join(directory, 'workspace'), fixtureFile = join(directory, 'fixture.json'), effectsFile = join(directory, 'effects.txt');
const stopCase = stage === 'stop-saved';
const ready = async (snapshot: object) => {
  console.log(JSON.stringify({ type: 'ready', ...snapshot }));
  await setTimeout(60_000);
};
const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
  fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' });
const model = { provider: 'collaboration-recovery', modelId: 'scripted' }, models = createModels();
const provider = fauxProvider({ provider: model.provider, models: [{ id: model.modelId }] });
const effects = defineExtension({ name: 'collaboration_recovery_effects', tools: [
  defineTool({ name: 'record_effect', description: 'Record the original synthetic effect.', parameters: Type.Object({ label: Type.String() }),
    execute: async ({ label }) => { await appendFile(effectsFile, label + '\n'); return { output: [] }; } }),
  defineTool({ name: 'hold_original', description: 'Wait until the original work is stopped.', parameters: Type.Object({}), replay: 'safe',
    execute: async (_args, _api, context) => {
      if (phase === 'recover') await appendFile(effectsFile, 'stopped work restarted\n');
      if (!context.abortSignal?.aborted) await new Promise<void>(resolve => context.abortSignal!.addEventListener('abort', () => resolve(), { once: true }));
      return { output: [] };
    } }),
] });
let role: { id: string; revision: number };
provider.setResponses(Array.from({ length: 32 }, () => transcript => {
  const index = transcript.messages.findLastIndex(message => message.role === 'user');
  const last = transcript.messages[index], user = last?.role === 'user' ? String(last.content) : '';
  const results = transcript.messages.slice(index).filter(message => message.role === 'toolResult');
  if (!hasTool(transcript, 'task_submit')) {
    if (user === 'FIRST_LIVE') return call('hold_original', {});
    if (user === 'SECOND_QUEUED' || user.startsWith('ASSISTANT_ANSWER ')) {
      if (user.startsWith('ASSISTANT_ANSWER ')) assert(user.includes('blue'));
      return results.some(result => result.toolName === 'record_effect')
        ? fauxAssistantMessage('Original recovered result.')
        : call('record_effect', { label: stopCase ? 'queued sibling' : 'original answer' });
    }
    return call('assistant_ask', { question: 'Choose a colour.', options: ['blue', 'green'] });
  }
  if (user.startsWith('ASSISTANT_REPORT ')) return call('task_submit', { summary: 'Recovered the original collaboration.', artifacts: [] });
  if (user.startsWith('ASSISTANT_QUESTION ')) return fauxAssistantMessage('Waiting for selection.');
  const assigned = results.filter(result => result.toolName === 'assistant_assign');
  if (!assigned.length || stopCase && assigned.length === 1) {
    return call('assistant_assign', { assistant: role, instructions: stopCase ? assigned.length ? 'SECOND_QUEUED' : 'FIRST_LIVE' : 'Ask for a colour.' });
  }
  return fauxAssistantMessage('Original work is in progress.');
}));
models.setProvider(provider.provider);
const runtime = new LocalRuntime({ dataDir: directory, port: 4317, model, maxSubagents: 2, maxDurationMs: 60_000,
  web: false, discovery: false, review: false }, { models, extensions: [effects] });

try {
  if (phase === 'create') {
    await mkdir(workspace);
    const { id, revision } = await runtime.assistants.create({ workspace, name: 'Recovery peer', instructions: 'Follow the original assigned work.',
      tools: stopCase ? ['hold_original', 'record_effect'] : ['assistant_ask', 'record_effect'] });
    role = { id, revision };
    const task = await runtime.create('Run the original collaboration.', workspace, [], { collaborators: [role] });
    await writeFile(fixtureFile, JSON.stringify({ taskId: task.id, role }));
    const waiting = await until(() => runtime.status(task.id), state => stopCase
      ? state.assistantWork.length === 2 && state.activeTools.some(tool => tool.name === 'hold_original') : state.status === 'waiting_assistant');
    const snapshot = { ids: waiting.assistantWork.map(work => work.id), deadline: waiting.deadlineAt };
    const first = waiting.assistantWork[0]!;
    const active = runtime['active'].get(task.id)!;
    if (stopCase) {
      active.harness.abortTask = async () => {
        assert((await active.harness.snapshot(AssistantPeers, ctx))!.work[first.id]!.stop);
        await ready(snapshot);
        throw new Error('Stop recovery fixture was not killed.');
      };
      await runtime.stopAssignedAssistant(task.id, first.id, first.controlVersion, 'stop-original-work');
    } else {
      const originalControl = runtime['peerControl'].bind(runtime);
      runtime['peerControl'] = state => action => originalControl(state)(async control => {
        const result = await action(control);
        const saved = (await state.harness.snapshot(AssistantPeers, ctx))!.work[first.id]!;
        if (Object.values(saved.questions ?? {}).some(question => question.answer?.requestId === 'original-owner-answer')) await ready(snapshot);
        return result;
      });
      await runtime.inputAssistantWork(task.id, { id: first.id, questionId: first.questions[0]!.id,
        requestId: 'original-owner-answer', text: 'blue' }, 'answer');
    }
    throw new Error('Expected the recovery fixture to be killed.');
  }
  const saved = JSON.parse(await readFile(fixtureFile, 'utf8')) as { taskId: string; role: typeof role };
  role = saved.role;
  await runtime.recover();
  const done = await until(() => runtime.status(saved.taskId), state => state.status === 'completed' || state.status === 'needs_attention');
  assert.equal(done.status, 'completed', JSON.stringify({ goal: done.goal, work: done.assistantWork }));
  console.log(JSON.stringify({ ids: done.assistantWork.map(work => work.id), deadline: done.deadlineAt,
    summary: done.goal?.candidate?.summary, effects: await readFile(effectsFile, 'utf8'),
    stopped: done.assistantWork.filter(work => work.stop?.confirmed).length,
    reports: done.messages.filter(message => message.role === 'user' && String(message.content).startsWith('ASSISTANT_REPORT ')).length }));
} finally {
  await runtime.close();
}
