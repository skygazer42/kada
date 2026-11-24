import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { createModels, createProvider, fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentTools, type StreamOptions, type TranscriptContext } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { Harness, ToolTask, createRegistry, defineExtension, hook, wrapTool } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { conversationAnswer } from '../src/conversation.js';
import { localEnvironment, localExecution, taskCompaction } from '../src/execution.js';
import { cloudModels } from '../src/models.js';
import { LocalRuntime } from '../src/runtime.js';

const selfTest = process.argv.includes('--self-test');
assert(selfTest !== process.argv.includes('--live'), 'Select --self-test or --live.');
const selectedArm = process.argv.find(argument => /^--arm(?:=|$)/.test(argument))?.slice('--arm='.length);
assert(selectedArm === undefined || selectedArm === 'pi' || selectedArm === 'kada', 'Select --arm=pi or --arm=kada.');
const arms: readonly ('pi' | 'kada')[] = selectedArm ? [selectedArm] : ['pi', 'kada'];
const preference = 'For this project my daily report title preference is exactly "Daily brief | Iris-7391".';
const question = 'Which release channel should I use?';
const reply = 'Use the orchid release channel. Please finish the same report.';
const objective = 'Prepare a daily report using the saved project title preference in AGENTS.md. Sum the active amounts in sales.json. First write draft.json containing only the numeric total under the key total. Then ask "Which release channel should I use?" and wait for my answer before writing report.json. After my answer, write report.json with exactly three keys: title, total, and channel. Use the native read and write tools inside this workspace and keep AGENTS.md, sales.json and the saved draft intact. In a managed task use task_blocked to ask and task_submit to deliver report.json. In plain Pi ask in your reply and deliver with a final reply.';
const inputs = { 'AGENTS.md': preference + '\n', 'sales.json': '[{"amount":19,"active":true},{"amount":23,"active":true},{"amount":999,"active":false}]\n' };
const expectedDraft = { total: 42 };
const expectedReport = { title: 'Daily brief | Iris-7391', total: 42, channel: 'orchid' };
const limits = { maxDurationMs: 180_000, maxModelRequests: 18, maxOutputTokens: 1024, maxTotalTokens: 60_000 };
const modelId = process.env.SILICONFLOW_MODEL ?? 'deepseek-ai/DeepSeek-V3.2';
const model = selfTest ? { provider: 'handoff-fixture', modelId: 'scripted' } : { provider: 'siliconflow', modelId };
const directory = resolve('.harness/handoff-comparison', randomUUID());

async function credential() {
  const env = process.env.SILICONFLOW_API_KEY?.trim();
  delete process.env.SILICONFLOW_API_KEY;
  if (env) return env;
  assert(process.stdin.isTTY || process.argv.includes('--credential-stdin'), 'Set SILICONFLOW_API_KEY or use --credential-stdin.');
  const raw = process.stdin.isRaw;
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  const input = createInterface({ input: process.stdin, terminal: false });
  try {
    console.log('READY_FOR_CREDENTIAL');
    const key = await new Promise<string>(done => { input.once('line', done); input.once('close', () => done('')); });
    assert(key.trim(), 'A SiliconFlow credential is required.');
    return key.trim();
  } finally {
    input.close();
    if (process.stdin.isTTY) process.stdin.setRawMode(raw === true);
    process.stdin.pause();
  }
}

const apiKey = selfTest ? undefined : await credential();

async function persistedFile(path: string): Promise<string | null> {
  try { return await readFile(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function matchesJson(raw: string | null, expected: unknown): boolean {
  if (raw === null) return false;
  try { return isDeepStrictEqual(JSON.parse(raw), expected); }
  catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  }
}

async function compare(arm: 'pi' | 'kada') {
  const dataDir = join(directory, arm), workspace = join(dataDir, 'workspace'), home = join(dataDir, 'home');
  await Promise.all([mkdir(home, { recursive: true }), mkdir(workspace, { recursive: true })]);
  await Promise.all([...Object.entries(inputs), ['.kada-project', '']].map(([name, content]) => writeFile(join(workspace, name!), content!)));
  const startedAt = Date.now(), deadline = AbortSignal.timeout(limits.maxDurationMs);
  const usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, totalTokens: 0 };
  const evidence = { sessionReopened: false, pausedForOperator: false, retainedQuestion: false, memoryReferenceRetained: null as boolean | null,
    draftVerified: false };
  const modelUsage: Promise<void>[] = [];
  const nativeCalls: Record<string, number> = {};
  let firstRequestTools: { count: number; bytes: number; source: 'transcript' | 'provider-payload' } | null = null;
  let modelRequests = 0, providerErrors = 0, userContinuationMessages = 0, reworks = 0, stage = 'start', execution = 'pending';
  const models = createModels(), nativeTools = localExecution();
  const nativeNames = new Set(nativeTools.tools!.map(tool => tool.name));
  function countRequest(context: TranscriptContext) {
    deadline.throwIfAborted();
    assert(modelRequests < limits.maxModelRequests && usage.totalTokens < limits.maxTotalTokens, 'Comparison request or token limit reached.');
    modelRequests++;
    const tools = getCurrentTools(context.messages);
    assert.deepEqual(tools.filter(tool => nativeNames.has(tool.name)).map(tool => tool.name).sort(), ['read', 'write']);
    return tools;
  }
  if (selfTest) {
    const provider = fauxProvider({ provider: model.provider, models: [{ id: model.modelId }] });
    const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' });
    provider.setResponses(Array.from({ length: limits.maxModelRequests }, () => (context: TranscriptContext) => {
      const tools = countRequest(context);
      firstRequestTools ??= { count: tools.length, bytes: Buffer.byteLength(JSON.stringify(tools)), source: 'transcript' };
      const managed = tools.some(tool => tool.name === 'task_blocked');
      const used = (name: string) => context.messages.filter(message => message.role === 'toolResult' && message.toolName === name && !message.isError).length;
      if (!used('read')) return call('read', { path: 'sales.json' });
      if (!used('write')) return call('write', { path: 'draft.json', content: JSON.stringify(expectedDraft) });
      if (!context.messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes('orchid'))) {
        return managed ? call('task_blocked', { reason: 'Draft saved. Release channel is required.', question }) : fauxAssistantMessage('Draft saved. Now, ' + question.toLowerCase());
      }
      if (used('write') < 2) return call('write', { path: 'report.json', content: JSON.stringify(expectedReport) });
      return managed ? call('task_submit', { summary: 'Verified daily report', artifacts: ['report.json'] }) : fauxAssistantMessage('Verified report.json');
    }));
    models.setProvider(provider.provider);
  } else {
    const selected = cloudModels().getModel(model.provider, model.modelId);
    assert(selected, 'Select an installed SiliconFlow model.');
    const native = openAICompletionsApi();
    const options = <T extends StreamOptions>(context: TranscriptContext, input?: T) => {
      countRequest(context);
      const onPayload: StreamOptions['onPayload'] = async (payload, selected) => {
        const replacement = await input?.onPayload?.(payload, selected);
        if (!firstRequestTools) {
          const { tools = [] } = (replacement ?? payload) as { tools?: unknown[] };
          firstRequestTools = { count: tools.length, bytes: Buffer.byteLength(JSON.stringify(tools)), source: 'provider-payload' };
        }
        return replacement;
      };
      return { ...input, maxTokens: Math.min(input?.maxTokens ?? limits.maxOutputTokens, limits.maxOutputTokens),
        signal: input?.signal ? AbortSignal.any([input.signal, deadline]) : deadline, onPayload };
    };
    const observe = (stream: ReturnType<typeof native.stream>) => {
      modelUsage.push(stream.result().then(({ usage: spent, stopReason }) => {
        usage.inputTokens += spent.input;
        usage.outputTokens += spent.output;
        usage.cachedTokens += spent.cacheRead;
        usage.cacheWriteTokens += spent.cacheWrite;
        usage.totalTokens += spent.totalTokens;
        if (stopReason === 'error' || stopReason === 'aborted') providerErrors++;
      }, () => { providerErrors++; }));
      return stream;
    };
    models.setProvider(createProvider({ id: model.provider, models: [{ ...selected, maxTokens: limits.maxOutputTokens }], baseUrl: selected.baseUrl,
      auth: { apiKey: { name: 'SiliconFlow handoff comparison', resolve: async () => ({ auth: { apiKey: apiKey! } }) } },
      api: { stream: (selected, context, input) => observe(native.stream(selected, context, options(context, input))),
        streamSimple: (selected, context, input) => observe(native.streamSimple(selected, context, options(context, input))) } }));
  }

  const outputs = ['draft.json', 'report.json'];
  const readable = new Set([...Object.keys(inputs), ...outputs].map(name => join(workspace, name)));
  const writable = new Set(outputs.map(name => join(workspace, name)));
  const scope = defineExtension({ name: 'handoff_comparison_scope',
    wraps: nativeTools.tools!.filter(tool => tool.name !== 'read' && tool.name !== 'write')
      .map(tool => wrapTool(tool, native => ({ ...native, callers: ['tools'] }))),
    hooks: [hook(ToolTask, {
    beforeTool(call) {
      if (['task_blocked', 'task_status', 'task_submit'].includes(call.name)) return;
      const allowed = call.name === 'read' ? readable : call.name === 'write' ? writable : undefined;
      const path = call.arguments.path;
      if (typeof path !== 'string' || !allowed?.has(resolve(workspace, path))) return { block: 'Use only the fixture files through native read and write.' };
      nativeCalls[call.name] = (nativeCalls[call.name] ?? 0) + 1;
    },
  })] });
  const registry = createRegistry();
  for (const extension of [nativeTools, scope]) registry.install(extension);
  const openPi = async () => Harness.open(await openNodeSqliteStorage(join(dataDir, 'session.sqlite')), {
    models, registry, env: ({ cwd }) => localEnvironment(cwd ?? workspace),
    settings: { retry: { maxRetries: 2 }, stream: { timeoutMs: 120_000 }, toolExecution: 'parallel', compaction: taskCompaction(models, [model]) },
  }, ctx);
  const openKada = () => new LocalRuntime({ dataDir, port: 4317, model, maxSubagents: 1, maxDurationMs: limits.maxDurationMs,
    maxTotalTokens: limits.maxTotalTokens, review: false, web: false, discovery: true }, { models, discovery: { home }, extensions: [scope] });
  let pi: Harness | undefined, kada: LocalRuntime | undefined, draft: string | undefined;
  let executionPassed = false;
  async function checkDraft() {
    stage = 'verify_draft_before_operator';
    const snapshot = await readFile(join(workspace, 'draft.json'), 'utf8');
    assert.deepEqual(JSON.parse(snapshot), expectedDraft);
    await assert.rejects(readFile(join(workspace, 'report.json')), { code: 'ENOENT' });
    draft = snapshot;
    evidence.draftVerified = true;
  }
  function sawQuestion(text: string | undefined) { return text?.toLowerCase().includes(question.toLowerCase()) === true; }
  async function wait(taskId: string) {
    for (;;) {
      deadline.throwIfAborted();
      const state = await kada!.status(taskId);
      if (!['running', 'pending', 'verifying'].includes(state.status) && !state.tasks.length) return state;
      await setTimeout(100, undefined, { signal: deadline });
    }
  }
  try {
    stage = 'first_turn';
    if (arm === 'pi') {
      pi = await openPi();
      let root = await pi.root(ctx, { agent: { model, cwd: workspace, extensions: [nativeTools, scope],
        instructions: 'Execute the confirmed task with native Pi tools, using this project guidance from AGENTS.md:\n' + await readFile(join(workspace, 'AGENTS.md'), 'utf8') } });
      const first = await root.submit({ type: 'input', content: objective, requestId: 'initial' }, ctx);
      execution = (await first.wait(ctx)).status;
      const rootId = root.id;
      evidence.pausedForOperator = execution === 'done' && (await root.context(ctx)).messages.some(message => sawQuestion(conversationAnswer(message)));
      assert(evidence.pausedForOperator);
      await checkDraft();
      stage = 'reopen';
      await pi.close(ctx);
      pi = await openPi();
      root = await pi.root(ctx);
      evidence.sessionReopened = root.id === rootId;
      evidence.retainedQuestion = (await root.context(ctx)).messages.some(message => sawQuestion(conversationAnswer(message)));
      assert(evidence.sessionReopened && evidence.retainedQuestion);
      stage = 'operator_reply';
      const second = await root.submit({ type: 'input', content: reply, requestId: 'operator' }, ctx);
      userContinuationMessages++;
      execution = (await second.wait(ctx)).status;
      assert.equal(execution, 'done');
    } else {
      kada = openKada();
      const task = await kada.create(objective, workspace, [{ type: 'file_exists', path: 'report.json' }], { skills: [] });
      const first = await wait(task.id);
      execution = first.status;
      evidence.pausedForOperator = execution === 'waiting_user' && sawQuestion(first.goal?.question ?? undefined);
      assert(evidence.pausedForOperator);
      await checkDraft();
      stage = 'reopen';
      const before = await kada.taskMemory(task.id);
      await kada.close();
      kada = openKada();
      await kada.recover();
      const recovered = await kada.status(task.id), after = await kada.taskMemory(task.id);
      evidence.sessionReopened = recovered.id === task.id && recovered.conversations[0]?.id === first.conversations[0]?.id;
      evidence.retainedQuestion = recovered.status === 'waiting_user' && recovered.goal?.question === first.goal?.question;
      const reference = after.references.find(ref => ref.scope === 'project' && ref.text === preference && ref.evidence.some(source => source.path === join(workspace, 'AGENTS.md')));
      evidence.memoryReferenceRetained = !!reference && before.current.includes(reference.factId + '@' + reference.revision) && after.current.includes(reference.factId + '@' + reference.revision);
      assert(evidence.sessionReopened && evidence.retainedQuestion && evidence.memoryReferenceRetained);
      stage = 'operator_reply';
      await kada.followUp(task.id, reply, 'operator');
      userContinuationMessages++;
      const result = await wait(task.id);
      execution = result.status;
      reworks = result.goal?.reworks ?? 0;
      assert.equal(execution, 'completed');
    }
    assert.equal(userContinuationMessages, 1);
    executionPassed = true;
  } catch (error) {
    console.error(JSON.stringify({ arm, stage, failure: error instanceof assert.AssertionError ? 'independent_assertion_failed' : 'operation_failed',
      ...(selfTest && error instanceof Error ? { diagnostic: error.message } : {}) }));
  } finally {
    await pi?.close(ctx);
    await kada?.close();
    await Promise.all(modelUsage);
  }
  const [finalDraft, finalReport, inputMatches] = await Promise.all([
    persistedFile(join(workspace, 'draft.json')),
    persistedFile(join(workspace, 'report.json')),
    Promise.all(Object.entries(inputs).map(async ([name, expected]) => (await persistedFile(join(workspace, name))) === expected)),
  ]);
  const inputsPreserved = inputMatches.every(Boolean);
  const draftPreserved = draft === undefined ? null : finalDraft === draft;
  const draftMatches = matchesJson(finalDraft, expectedDraft);
  const reportMatches = matchesJson(finalReport, expectedReport);
  const verifiedResult = executionPassed && inputsPreserved && draftPreserved === true && reportMatches;
  return { arm, execution, elapsedMs: Date.now() - startedAt, modelRequests, providerErrors, firstRequestTools, usage, estimatedCostUsd: null,
    userContinuationMessages, reworks, nativeCalls, ...evidence, inputsPreserved, draftPreserved, draftMatches, reportMatches,
    verifiedResult, passed: verifiedResult };
}

const results = [];
for (const arm of arms) {
  const result = await compare(arm);
  results.push(result);
  console.log(JSON.stringify(result));
}
const report = join(directory, 'comparison.json');
await writeFile(report, JSON.stringify({ at: new Date().toISOString(), mode: selfTest ? 'scripted-model' : 'siliconflow', model, objective, reply, limits, results,
  note: 'Single synthetic task per selected arm. Broader performance needs repeated tasks and counterbalanced order. SiliconFlow pricing is unavailable in the installed catalog.' }, null, 2) + '\n');
const passed = results.every(result => result.passed);
console.log(JSON.stringify({ report, passed }));
if (!passed) process.exitCode = 1;
