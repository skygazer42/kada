import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { LocalRuntime } from '../../src/runtime.js';
import { Questions } from '../../src/questions.js';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { until } from '../helpers.js';

const [phase, directory, stage] = process.argv.slice(2) as [string, string, string];
const workspace = join(directory, 'workspace'), statePath = join(directory, 'fixture.json');
const secret = 'synthetic-recovery-private-value', replacement = 'synthetic-owner-rotated-value';
const state: { id: string; questionId?: string } = phase === 'create' ? { id: '5c52d4ce-cd0c-4b73-a3f7-5049fcb746a8' } : JSON.parse(await readFile(statePath, 'utf8'));
const execution = stage === 'goal-answer';
const model = { provider: 'credential-recovery', modelId: 'scripted' }, faux = fauxProvider({ provider: model.provider, models: [{ id: model.modelId }] });
faux.setResponses(Array.from({ length: 8 }, () => async context => {
  if (JSON.stringify(context).includes(secret) || JSON.stringify(context).includes(replacement)) throw new Error('Credential entered model context.');
  await appendFile(join(directory, 'model-calls.txt'), 'model\n');
  if (context.messages.some(message => message.role === 'user' && String(message.content).includes('Credential reports saved'))) {
    return execution ? fauxAssistantMessage(fauxToolCall('task_submit', { summary: 'Credential saved. No external action taken.', artifacts: [] }), { stopReason: 'toolUse' }) : fauxAssistantMessage('Credential saved.');
  }
  return fauxAssistantMessage(fauxToolCall('request_credential', { name: 'reports', origin: 'https://api.example', auth: { type: 'bearer' }, label: 'Reports', reason: 'Configure API.' }), { stopReason: 'toolUse' });
}));
const models = createModels(); models.setProvider(faux.provider);
const runtime = new LocalRuntime({ dataDir: directory, port: 4317, model, maxSubagents: 0, maxDurationMs: 600_000, review: false, web: false, discovery: false }, { models });
try {
  if (phase === 'create') {
    await mkdir(workspace);
    await runtime.create('Configure API.', workspace, [], { id: state.id, chat: !execution });
    const waiting = await until(() => runtime.status(state.id), row => row.status === 'waiting_user' && row.submission?.status === 'done');
    state.questionId = waiting.userQuestion!.id; await writeFile(statePath, JSON.stringify(state));
    if (stage === 'store-saved') {
      const save = runtime.credentials.save.bind(runtime.credentials);
      runtime.credentials.save = async input => {
        const result = await save(input);
        console.log(JSON.stringify({ type: 'ready', taskId: state.id })); await setTimeout(60_000); return result;
      };
    } else if (execution) runtime['dispatchOutbox'] = async () => {
      console.log(JSON.stringify({ type: 'ready', taskId: state.id })); await setTimeout(60_000);
    };
    else {
      const dispatch = runtime['dispatchQuestionOutbox'].bind(runtime);
      runtime['dispatchQuestionOutbox'] = async active => {
        if (!(await active.harness.snapshot(Questions, active.root.id, ctx))?.outbox) return dispatch(active);
        console.log(JSON.stringify({ type: 'ready', taskId: state.id })); await setTimeout(60_000);
      };
    }
    await runtime.provideCredential(state.id, state.questionId!, secret);
  } else {
    await runtime.credentials.save({ project: workspace, name: 'reports', origin: 'https://api.example', auth: { type: 'bearer' }, value: replacement, expectedRevision: 1, requestId: 'later-owner-edit' });
    await runtime.recover();
    if (stage === 'store-saved') {
      let refusedDecline = false;
      try { await runtime.provideCredential(state.id, state.questionId!, undefined); } catch (error) { refusedDecline = (error as { status: number }).status === 409; }
      if (!refusedDecline) throw new Error('A saved value cannot be reported as declined.');
    }
    await runtime.provideCredential(state.id, state.questionId!, secret);
    const done = await until(() => runtime.status(state.id), row => row.status === (execution ? 'completed' : 'answered'));
    if (JSON.stringify(done).includes(secret) || JSON.stringify(done).includes(replacement)) throw new Error('Public state contains a value.');
    const saved = await runtime.credentials.list(workspace);
    const disk = await readFile(join(directory, 'application-credentials', 'items.json'), 'utf8');
    console.log(JSON.stringify({ type: 'completed', revision: saved[0].revision, replacementKept: disk.includes(replacement), oldValueAbsent: !disk.includes(secret),
      answers: done.messages.filter(message => message.role === 'user' && String(message.content).includes('Credential reports saved')).length,
      goal: done.goal ? 'existing' : null }));
  }
} finally { await runtime.close(); }
