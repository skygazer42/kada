import assert from 'node:assert/strict';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { LocalRuntime } from '../../src/runtime.js';
import { hasTool, until } from '../helpers.js';

const [phase, dataDir] = process.argv.slice(2) as [string, string];
const parent = '1f000040-bb9d-4ca2-9768-fead7aee2916';
const workspace = join(dataDir, 'workspace'), preparationLog = join(dataDir, 'prepare.txt');
const message = 'Prepare an independent sample review.';
const model = { provider: 'thread-recovery-model', modelId: 'scripted' };
const provider = fauxProvider({ provider: model.provider, models: [{ id: model.modelId }] });
provider.setResponses(Array.from({ length: 12 }, () => async context => {
  const latest = context.messages.findLast(item => item.role === 'user');
  if (latest?.content === message) {
    assert(!hasTool(context, 'task_submit'));
    await appendFile(preparationLog, 'prepare\n');
    return fauxAssistantMessage(fauxToolCall('task_prepare', { outcome: 'Review the sample', deliverables: ['Text'], inputs: [],
      criteria: [{ text: 'Verified sample', method: 'inspect' }], scope: ['Synthetic workspace'], assumptions: [], questions: [] }), { stopReason: 'toolUse' });
  }
  const receipt = context.messages.find(item => item.role === 'toolResult' && item.toolName === 'start_thread');
  if (receipt?.role === 'toolResult') {
    assert(!receipt.isError);
    return fauxAssistantMessage('Original thread prepared.');
  }
  return fauxAssistantMessage(fauxToolCall('start_thread', { title: 'Review after restart', message }), { stopReason: 'toolUse' });
}));
const models = createModels();
models.setProvider(provider.provider);
const runtime = new LocalRuntime({ dataDir, port: 4317, model, maxSubagents: 1, maxDurationMs: 120_000, web: false,
  review: false, discovery: false }, { models });

try {
  if (phase === 'create') {
    await mkdir(workspace);
    const open = runtime['open'].bind(runtime);
    runtime['open'] = async (meta, run) => {
      if (run && meta.thread?.sourceTaskId === parent) {
        assert.equal((await runtime.metadata(meta.id)).creationHash, meta.creationHash);
        console.log(JSON.stringify({ type: 'ready', parent, id: meta.id }));
        await setTimeout(60_000);
      }
      return open(meta, run);
    };
    await runtime.create('Open a separate review thread.', workspace, [], { chat: true, id: parent });
    await setTimeout(60_000);
  } else {
    await runtime.recover();
    const original = await until(() => runtime.status(parent), row => row.status === 'answered');
    const result = original.messages.find(item => item.role === 'toolResult' && item.toolName === 'start_thread');
    assert(result?.role === 'toolResult' && !result.isError);
    const { id: receipt } = JSON.parse(result.content.map(part => part.type === 'text' ? part.text : '').join(''));
    const child = await until(() => runtime.status(receipt), row => row.status === 'awaiting_confirmation');
    assert.equal(child.thread?.sourceTaskId, parent);
    console.log(JSON.stringify({ id: child.id, parent, receipt, threads: (await runtime.list()).length,
      preparations: await readFile(preparationLog, 'utf8'), inputs: child.messages.filter(item => item.role === 'user').length,
      confirmed: Boolean(child.goal?.confirmation) }));
  }
} finally { await runtime.close(); }
