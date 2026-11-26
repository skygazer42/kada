import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { LocalRuntime } from '../../src/runtime.js';
import { threadTaskId } from '../../src/task-threads.js';
import { hasTool, until } from '../helpers.js';

const [phase, directory, action] = process.argv.slice(2) as [string, string, string];
const parent = '1f000040-bb9d-4ca2-9768-fead7aee2916', workspace = join(directory, 'workspace');
const close = action === 'close', toolName = close ? 'close_thread' : 'rename_thread';
const target = close ? threadTaskId(parent, 'owner', 'finish-before-close') : parent;
const model = { provider: 'thread-edit-recovery', modelId: 'scripted' };
const provider = fauxProvider({ provider: model.provider, models: [{ id: model.modelId }] });
const tool = (name: string, args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' });
provider.setResponses(Array.from({ length: 16 }, () => context => {
  const input = context.messages.findLast(message => message.role === 'user')?.content;
  if (hasTool(context, 'task_submit')) return tool('task_submit', { summary: 'Verified synthetic report.', artifacts: [],
    criteria: [{ id: 1, status: 'passed', evidence: 'Report verified.' }] });
  if (input === 'Finish the synthetic report.') return tool('task_prepare', { outcome: 'Finish the report', deliverables: ['Text'], inputs: [],
    criteria: [{ text: 'Report verified', method: 'inspect' }], scope: ['Fixture'], assumptions: [], questions: [] });
  if (input !== 'Manage the original thread.') return fauxAssistantMessage('Original conversation.');
  const result = context.messages.find(message => message.role === 'toolResult' && message.toolName === toolName);
  if (result?.role === 'toolResult') {
    assert(!result.isError);
    return fauxAssistantMessage('Original thread operation accepted.');
  }
  return close ? tool(toolName, { thread_id: target, revision: 1 }) : tool(toolName, { title: 'Assistant title', revision: 0 });
}));
const models = createModels();
models.setProvider(provider.provider);
const runtime = new LocalRuntime({ dataDir: directory, port: 4317, model, maxSubagents: 1, maxDurationMs: 120_000,
  web: false, review: false, discovery: false }, { models });

try {
  if (phase === 'create') {
    await mkdir(workspace);
    await runtime.create('Set up the original conversation.', workspace, [], { id: parent, chat: true });
    await until(() => runtime.status(parent), state => state.status === 'answered');
    if (close) {
      await runtime.startThread(parent, { title: 'Close after delivery', message: 'Finish the synthetic report.', requestId: 'finish-before-close' });
      const pending = await until(() => runtime.status(target), state => state.status === 'awaiting_confirmation');
      await runtime.confirm(target, pending.goal!.brief!.revision, pending.briefDigest!);
      await until(() => runtime.status(target), state => state.status === 'completed');
    }
    const edit = runtime.editThread.bind(runtime);
    runtime.editThread = async (id, value, caller) => {
      const receipt = await edit(id, value, caller);
      assert(caller);
      assert.equal(id, target);
      console.log(JSON.stringify({ type: 'ready', revision: receipt.revision, receipt }));
      await setTimeout(60_000);
      return receipt;
    };
    await runtime.followUp(parent, 'Manage the original thread.', 'managed-original');
    await setTimeout(60_000);
  } else {
    const prior = await runtime.metadata(target);
    assert(prior.thread);
    await runtime.editThread(target, { revision: prior.thread.revision, title: 'Owner retained title', ...(close ? { archived: false } : {}) });
    await runtime.recover();
    const answered = await until(() => runtime.status(parent), state => state.status === 'answered' && state.submission?.requestId === 'user:managed-original');
    const message = answered.messages.find(item => item.role === 'toolResult' && item.toolName === toolName);
    assert(message?.role === 'toolResult' && !message.isError);
    const data = JSON.parse(message.content.map(part => part.type === 'text' ? part.text : '').join(''));
    const current = await runtime.metadata(target);
    console.log(JSON.stringify({ receipt: data.thread, title: current.thread?.title, archived: !!current.thread?.archivedAt,
      receiptCount: Object.keys(current.threadEditReceipts ?? {}).length, finalRevision: current.thread?.revision }));
  }
} finally { await runtime.close(); }
