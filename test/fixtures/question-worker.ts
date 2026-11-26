import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { defineExtension, hook, ToolTask } from '@earendil-works/pi-durable';
import { LocalRuntime } from '../../src/runtime.js';
import { Questions } from '../../src/questions.js';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { until } from '../helpers.js';

const [mode, directory, stage] = process.argv.slice(2);
const workspace = join(directory!, 'workspace'), statePath = join(directory!, 'fixture.json');
const state: { id: string; question?: string } = mode === 'create' ? { id: '8cf14741-bc50-48c9-9bf4-e456b7943df2' } : JSON.parse(await readFile(statePath, 'utf8'));
const goal = stage === 'question-saved' || stage === 'goal-answer';
const faux = fauxProvider({ provider: 'question-recovery', models: [{ id: 'scripted' }] });
faux.setResponses(Array.from({ length: 12 }, () => async context => {
  await appendFile(join(directory!, 'model-calls.txt'), 'model\n');
  if (context.messages.some(message => message.role === 'user' && message.content === 'CSV')) {
    return goal ? fauxAssistantMessage(fauxToolCall('task_submit', { summary: 'Selected CSV.', artifacts: [] }), { stopReason: 'toolUse' }) : fauxAssistantMessage('Selected CSV.');
  }
  return fauxAssistantMessage(fauxToolCall('ask_user', { question: 'Which format?', options: ['CSV', 'XLSX'] }), { stopReason: 'toolUse' });
}));
const models = createModels(); models.setProvider(faux.provider);
const hold = mode === 'create' && stage === 'question-saved' ? [defineExtension({ name: 'hold_question', hooks: [hook(ToolTask, {
  afterTool: async call => {
    if (call.name !== 'ask_user') return;
    console.log(JSON.stringify({ type: 'ready', taskId: state.id })); await setTimeout(60_000);
  },
})] })] : [];
const runtime = new LocalRuntime({ dataDir: directory!, port: 4317, model: { provider: faux.provider.id, modelId: 'scripted' },
  maxSubagents: 0, maxDurationMs: 600_000, review: false, web: false, discovery: false }, { models, extensions: hold });
try {
  if (mode === 'create') {
    await mkdir(workspace); await writeFile(statePath, JSON.stringify(state));
    if (stage === 'question-saved') clearInterval(runtime['timer']);
    await runtime.create('Ask which format.', workspace, [], { id: state.id, chat: !goal });
    if (stage === 'question-saved') { await setTimeout(60_000); }
    else {
      const waiting = await until(() => runtime.status(state.id), row => row.status === 'waiting_user' && row.tasks.length === 0);
      state.question = waiting.userQuestion!.id; await writeFile(statePath, JSON.stringify(state));
      if (goal) runtime['dispatchOutbox'] = async () => {
        console.log(JSON.stringify({ type: 'ready', taskId: state.id, questionId: state.question })); await setTimeout(60_000);
      };
      else {
        const dispatch = runtime['dispatchQuestionOutbox'].bind(runtime);
        runtime['dispatchQuestionOutbox'] = async active => {
          if (!(await active.harness.snapshot(Questions, active.root.id, context))?.outbox) return dispatch(active);
          console.log(JSON.stringify({ type: 'ready', taskId: state.id, questionId: state.question })); await setTimeout(60_000);
        };
      }
      await runtime.answerQuestion(state.id, state.question!, 'original-answer', 'CSV');
    }
  } else {
    await runtime.recover();
    if (stage === 'question-saved') {
      const waiting = await until(() => runtime.status(state.id), row => row.status === 'waiting_user' && row.tasks.length === 0);
      state.question = waiting.userQuestion!.id;
      await runtime.answerQuestion(state.id, state.question, 'original-answer', 'CSV');
    }
    const done = await until(() => runtime.status(state.id), row => row.status === (goal ? 'completed' : 'answered'));
    await runtime.answerQuestion(state.id, state.question!, 'original-answer', 'CSV');
    console.log(JSON.stringify({ type: 'completed', status: done.status, goal: done.goal ?? null, question: done.userQuestion,
      answers: done.messages.filter(message => message.role === 'user' && message.content === 'CSV').length }));
  }
} finally { await runtime.close(); }
