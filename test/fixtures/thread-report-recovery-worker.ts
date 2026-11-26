import assert from 'node:assert/strict';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { LocalRuntime } from '../../src/runtime.js';
import { threadReportRequestPrefix } from '../../src/task-threads.js';
import { hasTool, until } from '../helpers.js';

const [phase, dataDir, boundary] = process.argv.slice(2) as [string, string, string];
const parent = '1f000040-bb9d-4ca2-9768-fead7aee2916', workspace = join(dataDir, 'workspace');
const log = join(dataDir, 'report-replies.txt'), summary = 'Original verified result 42.';
const model = { provider: 'thread-report-recovery', modelId: 'scripted' };
const provider = fauxProvider({ provider: model.provider, models: [{ id: model.modelId }] });
const tool = (name: string, args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' });
provider.setResponses(Array.from({ length: 12 }, () => async context => {
  const input = context.messages.findLast(message => message.role === 'user')?.content;
  if (typeof input === 'string' && input.includes('INDEPENDENT_THREAD_REPORT')) {
    assert(input.includes(summary));
    await appendFile(log, 'report\n');
    return fauxAssistantMessage('Original chat received 42.');
  }
  if (hasTool(context, 'task_submit')) return tool('task_submit', { summary, artifacts: [], criteria: [{ id: 1, status: 'passed', evidence: summary }] });
  if (input === 'Verify the record.') return tool('task_prepare', { outcome: 'Verify the record', deliverables: ['Text report'], inputs: [],
    criteria: [{ text: 'Verify the total', method: 'inspect' }], scope: ['Synthetic record'], assumptions: [], questions: [] });
  return fauxAssistantMessage('Original chat.');
}));
const models = createModels();
models.setProvider(provider.provider);
const runtime = new LocalRuntime({ dataDir, port: 4317, model, maxSubagents: 1, maxDurationMs: 120_000,
  web: false, review: false, discovery: false }, { models });

try {
  if (phase === 'create') {
    await mkdir(workspace);
    await runtime.create('Review the synthetic record with me.', workspace, [], { id: parent, chat: true });
    await until(() => runtime.status(parent), state => state.status === 'answered');
    const { id } = await runtime.startThread(parent, { title: 'Original record', message: 'Verify the record.', requestId: 'report-original', reportBack: true });
    const prepared = await until(() => runtime.status(id), state => state.status === 'awaiting_confirmation');
    if (boundary === 'saved') {
      runtime['deliverThreadReport'] = async report => {
        console.log(JSON.stringify({ type: 'ready', id: report.taskId, parent }));
        await setTimeout(60_000);
        return false;
      };
    } else {
      const root = runtime['active'].get(parent)!.root, submit = root.submit.bind(root);
      root.submit = async (draft, context) => {
        const accepted = await submit(draft, context);
        if (draft.requestId === threadReportRequestPrefix + id) {
          assert.equal((await accepted.wait(context)).status, 'done');
          console.log(JSON.stringify({ type: 'ready', id, parent, submissionId: accepted.id }));
          await setTimeout(60_000);
        }
        return accepted;
      };
    }
    await runtime.confirm(id, prepared.goal!.brief!.revision, prepared.briefDigest!);
    await setTimeout(60_000);
  } else {
    await runtime.recover();
    const origin = await until(() => runtime.status(parent), state => state.threadReports.length === 1 && state.status === 'answered');
    const report = origin.threadReports[0]!;
    const child = await runtime.status(report.taskId);
    const session = runtime['active'].get(parent)!;
    const submissions = (await session.storage.scanSubmissions({ conversationId: session.root.id }, 30, undefined, ctx)).items;
    const returned = submissions.filter(input => input.requestId === threadReportRequestPrefix + child.id);
    assert.equal(returned.length, 1);
    assert.equal(report.candidateId, child.goal?.candidate?.id);
    console.log(JSON.stringify({ id: report.taskId, parent, summary: report.summary, mode: report.mode, replies: await readFile(log, 'utf8'),
      submissionId: returned[0]!.id, reports: origin.threadReports.length, childStatus: child.status }));
  }
} finally { await runtime.close(); }
