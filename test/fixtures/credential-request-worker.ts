import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { request as httpRequest } from 'node:http';
import type { request as HttpsRequest } from 'node:https';
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { LocalRuntime } from '../../src/runtime.js';
import { until } from '../helpers.js';

const [phase, directory, rawPort] = process.argv.slice(2) as [string, string, string];
const workspace = join(directory, 'workspace'), taskId = '1a118d6f-8a71-416a-af26-c5b0c9d90d9e';
const secret = 'synthetic-nonreplayed-credential';
const faux = fauxProvider({ provider: 'credential-request-recovery', models: [{ id: 'scripted' }] });
faux.setResponses(Array.from({ length: 8 }, () => async context => {
  if (JSON.stringify(context).includes(secret)) throw new Error('A value reached model context.');
  const result = context.messages.find(message => message.role === 'toolResult' && message.toolName === 'credential_request');
  if (result) {
    if (!result.isError) throw new Error('Interrupted request must return an unknown result.');
    return fauxAssistantMessage(fauxToolCall('task_blocked', { reason: 'Authenticated request interrupted; inspect actual effect before retry.' }), { stopReason: 'toolUse' });
  }
  return fauxAssistantMessage(fauxToolCall('credential_request', { name: 'reports', revision: 1, url: 'https://api.example/change', method: 'POST', body: '{"synthetic":true}' }), { stopReason: 'toolUse' });
}));
const models = createModels(); models.setProvider(faux.provider);
const network = { lookup: async () => [{ address: '8.8.8.8', family: 4 }], request: ((options: any, done: any) => {
  if (phase !== 'create') throw new Error('A recovered interrupted request must not dispatch again.');
  const request = httpRequest({ ...options, protocol: 'http:', hostname: '127.0.0.1', port: Number(rawPort), lookup: undefined }, done);
  request.once('finish', async () => {
    await appendFile(join(directory, 'dispatch.txt'), 'sent\n');
    console.log(JSON.stringify({ type: 'ready', taskId }));
  });
  return request;
}) as typeof HttpsRequest };
const runtime = new LocalRuntime({ dataDir: directory, port: 4317, model: { provider: faux.provider.id, modelId: 'scripted' }, maxSubagents: 0, maxDurationMs: 600_000, review: false, web: false, discovery: false }, { models, credentialNetwork: network });
try {
  if (phase === 'create') {
    await mkdir(workspace);
    await runtime.credentials.save({ project: workspace, name: 'reports', origin: 'https://api.example', auth: { type: 'bearer' }, value: secret, expectedRevision: 0, requestId: 'owner-save' });
    await runtime.create('Perform the synthetic API action once.', workspace, [], { id: taskId });
    await setTimeout(60_000);
  } else {
    await runtime.recover();
    const done = await until(() => runtime.status(taskId), row => row.status === 'blocked');
    const tool = done.messages.find(message => message.role === 'toolResult' && message.toolName === 'credential_request');
    console.log(JSON.stringify({ type: 'completed', status: done.status, interrupted: tool?.role === 'toolResult' && tool.isError === true,
      dispatch: await readFile(join(directory, 'dispatch.txt'), 'utf8'), valueAbsent: !JSON.stringify(done).includes(secret) }));
  }
} finally { await runtime.close(); }
