import assert from 'node:assert/strict';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { LocalRuntime } from '../../src/runtime.js';
import { until } from '../helpers.js';

const [phase, dataDir] = process.argv.slice(2) as [string, string];
const id = 'c88d0cc9-09ae-4458-8176-b0b4abacc9a5';
const workspace = join(dataDir, 'project'), probes = join(dataDir, 'target-probes.txt');
const model = { provider: 'proposal-source', modelId: 'scripted' }, desired = { provider: 'proposal-target', modelId: 'scripted' };
const source = fauxProvider({ provider: model.provider, models: [{ id: model.modelId }] });
source.setResponses(Array.from({ length: 8 }, () => context => {
  const input = context.messages.findLast(item => item.role === 'user');
  if (input?.content === 'Reply OK.' || context.messages.some(item => item.role === 'toolResult' && item.toolName === 'propose_model')) {
    return fauxAssistantMessage('OK.');
  }
  return fauxAssistantMessage(fauxToolCall('propose_model', { ...desired, reason: 'Project model test.' }), { stopReason: 'toolUse' });
}));
const target = fauxProvider({ provider: desired.provider, models: [{ id: desired.modelId }] });
target.setResponses(Array.from({ length: 6 }, () => async () => {
  await appendFile(probes, 'target-probe\n');
  return fauxAssistantMessage('OK.');
}));
const models = createModels();
models.setProvider(source.provider);
models.setProvider(target.provider);
const runtime = new LocalRuntime({ dataDir, port: 4317, model, maxSubagents: 1, maxDurationMs: 120_000, review: false, discovery: false, web: false }, { models });

try {
  if (phase === 'create') {
    await mkdir(workspace);
    await runtime.create('Propose the fixture project model.', workspace, [], { chat: true, id });
    await until(() => runtime.status(id), status => status.status === 'answered');
    const [draft] = await runtime.projectModelProposals(id);
    assert(draft?.state === 'pending');
    const receipt = await runtime.decideProjectModel(id, draft.id, 'apply');
    console.log(JSON.stringify({ type: 'ready', receipt }));
    await setTimeout(60_000);
  } else {
    await runtime.recover();
    const [applied] = await runtime.projectModelProposals(id);
    assert(applied?.state === 'applied');
    assert.equal((await runtime.providers.check(model)).status, 'available');
    await runtime.providers.select(model, workspace);
    const receipt = await runtime.decideProjectModel(id, applied.id, 'apply');
    console.log(JSON.stringify({ receipt, selected: await runtime.providers.selected(model, workspace),
      originalChatModel: (await runtime.status(id)).model, probes: await readFile(probes, 'utf8') }));
  }
} finally { await runtime.close(); }
