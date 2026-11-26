import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { LocalRuntime } from '../../src/runtime.js';
import { threadTaskId } from '../../src/task-threads.js';
import { threadPostWakeId } from '../../src/thread-posts.js';
import { hasTool, until } from '../helpers.js';

const [phase, directory] = process.argv.slice(2) as [string, string];
const source = '1f000040-bb9d-4ca2-9768-fead7aee2916', workspace = join(directory, 'workspace');
const child = threadTaskId(source, 'owner', 'independent-post-target');
const model = { provider: 'thread-post-worker', modelId: 'scripted' };
const provider = fauxProvider({ provider: model.provider, models: [{ id: model.modelId }] });
const tool = (name: string, args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' });
provider.setResponses(Array.from({ length: 14 }, () => async (context, options) => {
  const input = context.messages.findLast(message => message.role === 'user')?.content;
  if (typeof input === 'string' && input.includes('THREAD_POST_WAKE')) {
    assert(input.includes('RECOVERABLE_NOTE'));
    if (phase === 'create') await setTimeout(60_000, undefined, { signal: options?.signal });
    return fauxAssistantMessage('Original note received after recovery.');
  }
  if (hasTool(context, 'task_submit')) return tool('task_submit', { summary: 'Verified work.', artifacts: [],
    criteria: [{ id: 1, status: 'passed', evidence: 'Checked.' }] });
  if (input === 'Finish the synthetic task.') return tool('task_prepare', { outcome: 'Finish the task', deliverables: ['Text'], inputs: [],
    criteria: [{ text: 'Checked text', method: 'inspect' }], scope: ['Fixture'], assumptions: [], questions: [] });
  if (input === 'Post and wake the completed work.' && !context.messages.some(message => message.role === 'toolResult' && message.toolName === 'post_to_thread')) {
    return tool('post_to_thread', { thread_id: child, message: 'RECOVERABLE_NOTE', wake: true, delivery_id: 'original-post' });
  }
  return fauxAssistantMessage('Ready.');
}));
const models = createModels();
models.setProvider(provider.provider);
const runtime = new LocalRuntime({ dataDir: directory, port: 4317, model, maxSubagents: 1, maxDurationMs: 120_000,
  web: false, review: false, discovery: false }, { models });

try {
  if (phase === 'create') {
    await mkdir(workspace);
    await runtime.create('Original conversation.', workspace, [], { id: source, chat: true });
    await runtime.startThread(source, { title: 'Original delivery', message: 'Finish the synthetic task.', requestId: 'independent-post-target' });
    const pending = await until(() => runtime.status(child), state => state.status === 'awaiting_confirmation');
    await runtime.confirm(child, pending.goal!.brief!.revision, pending.briefDigest!);
    const delivered = await until(() => runtime.status(child), state => state.status === 'completed');
    await until(() => runtime.status(source), state => state.status === 'answered');
    const root = runtime['active'].get(child)!.root, submit = root.submit.bind(root);
    root.submit = async (draft, context) => {
      const submission = await submit(draft, context);
      if (draft.requestId?.startsWith('thread-post-wake:')) {
        console.log(JSON.stringify({ type: 'ready', wakeSubmission: submission.id, originalDelivery: delivered.goal!.candidate!.id }));
        await setTimeout(60_000);
      }
      return submission;
    };
    await runtime.followUp(source, 'Post and wake the completed work.', 'recover-wake');
    await setTimeout(60_000);
  } else {
    await runtime.recover();
    const view = await until(() => runtime.status(child), state => state.threadPosts.some(note => !!note.reply));
    await until(() => runtime.status(source), state => state.status === 'answered' && state.submission?.requestId === 'user:recover-wake');
    assert.equal(view.status, 'completed');
    const active = runtime['active'].get(child)!;
    const records = (await active.storage.scanSubmissions({ conversationId: active.root.id }, 40, undefined, ctx)).items;
    const wakes = records.filter(input => !!threadPostWakeId(input));
    console.log(JSON.stringify({ wakeSubmission: wakes[0]?.id, originalDelivery: view.goal?.candidate?.id,
      notes: view.threadPosts.length, wakes: wakes.length, reply: view.threadPosts[0]?.reply }));
  }
} finally { await runtime.close(); }
