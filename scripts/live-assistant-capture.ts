import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { basename, join, normalize, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { createModels, createProvider } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { defineExtension, hook, ToolTask } from '@earendil-works/pi-durable';
import { createClient, type TaskMeta, type TaskStatus } from '../src/client.js';
import type { Config } from '../src/config.js';
import { cloudModels } from '../src/models.js';
import { serve } from '../src/server.js';
import type { SkillCatalogEntry } from '../src/skills.js';

const modelRef = { provider: 'siliconflow', modelId: process.env.SILICONFLOW_MODEL || 'deepseek-ai/DeepSeek-V3.2' };
const limits = { requests: 32, outputTokensPerRequest: 1024, tokensPerTask: 100_000, elapsedMs: 480_000 };
const name = 'fixture-invoice-total';
const skillDir = 'deliverables/' + name;
const script = 'scripts/sum.mjs';
const inputPath = 'input.json';
const resultPath = 'deliverables/result.json';
const args = [inputPath, resultPath];
const sourceCommand = ['node', skillDir + '/' + script, ...args].join(' ');
const verification = { command: 'node acceptance/check.mjs', inputs: ['acceptance', inputPath], outputs: ['deliverables'] };
const description = 'Sum nullable signed integer amounts from an invoice JSON array.';

async function seed(workspace: string, rows: Array<number | null>, expected: number) {
  await mkdir(join(workspace, 'acceptance'), { recursive: true });
  await mkdir(join(workspace, 'deliverables'));
  await writeFile(join(workspace, inputPath), JSON.stringify(rows));
  await writeFile(join(workspace, 'acceptance', 'check.mjs'), [
    "import assert from 'node:assert/strict';",
    "import { readFileSync } from 'node:fs';",
    'assert.equal(JSON.parse(readFileSync(' + JSON.stringify(resultPath) + ", 'utf8')), " + expected + ');',
    "console.log('PASS');",
  ].join('\n'));
}

async function credential() {
  const fromEnv = process.env.SILICONFLOW_API_KEY?.trim();
  delete process.env.SILICONFLOW_API_KEY;
  if (fromEnv) return fromEnv;
  const { stdin } = process;
  assert(stdin.isTTY || process.argv.includes('--credential-stdin'), 'Provide a SiliconFlow credential to run the live test.');
  const wasRaw = stdin.isRaw === true;
  if (stdin.isTTY) stdin.setRawMode(true);
  const input = createInterface({ input: stdin, terminal: false });
  try {
    console.log('READY_FOR_CREDENTIAL');
    return (await new Promise<string>(resolve => {
      input.once('line', resolve);
      input.once('close', () => resolve(''));
    })).trim();
  } finally {
    input.close();
    if (stdin.isTTY) stdin.setRawMode(wasRaw);
    stdin.pause();
  }
}

async function freePort() {
  const socket = createServer();
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', resolve);
  });
  const address = socket.address();
  assert(address && typeof address !== 'string');
  await new Promise<void>(resolve => socket.close(() => resolve()));
  return address.port;
}

const failureStates = ['failed', 'budget_limited', 'waiting_user', 'blocked', 'cancelled', 'paused', 'stopped'];

async function main() {
  const started = Date.now();
  let stage = 'opt_in';
  let requests = 0;
  const usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 0, errors: 0 };
  const evidence: Record<string, unknown> = {};
  const statuses = new Map<string, TaskStatus>();
  let daemon: Awaited<ReturnType<typeof serve>> | undefined;
  const abort = new AbortController();
  let passed = false;
  try {
    assert(process.argv.includes('--live'), 'Pass --live to opt into paid model calls.');
    stage = 'credential';
    const apiKey = await credential();
    assert(apiKey, 'A SiliconFlow credential is required.');
    stage = 'model';
    const model = cloudModels().getModel(modelRef.provider, modelRef.modelId);
    assert(model?.api === 'openai-completions', 'Select an installed SiliconFlow model.');
    const deadline = AbortSignal.any([abort.signal, AbortSignal.timeout(limits.elapsedMs)]);
    const native = openAICompletionsApi();
    const models = createModels();
    const options = <T extends { signal?: AbortSignal; maxTokens?: number }>(input?: T) => {
      deadline.throwIfAborted();
      input?.signal?.throwIfAborted();
      assert(requests < limits.requests, 'Live model request limit reached.');
      requests++;
      return {
        ...input,
        maxTokens: Math.min(input?.maxTokens ?? limits.outputTokensPerRequest, limits.outputTokensPerRequest),
        signal: input?.signal ? AbortSignal.any([deadline, input.signal]) : deadline,
      };
    };
    const observe = (stream: ReturnType<typeof native.stream>) => {
      void stream.result().then(message => {
        usage.inputTokens += message.usage.input;
        usage.outputTokens += message.usage.output;
        usage.cachedTokens += message.usage.cacheRead;
        usage.totalTokens += message.usage.totalTokens;
        if (message.stopReason === 'error' || message.stopReason === 'aborted') usage.errors++;
      });
      return stream;
    };
    models.setProvider(createProvider({
      id: modelRef.provider, baseUrl: model.baseUrl, models: [model],
      auth: { apiKey: { name: 'SiliconFlow live validation', resolve: async () => ({ auth: { apiKey } }) } },
      api: {
        stream: (model, context, input) => observe(native.stream(model, context, options(input))),
        streamSimple: (model, context, input) => observe(native.streamSimple(model, context, options(input))),
      },
    }));

    stage = 'fixtures';
    await mkdir('.harness', { recursive: true });
    const root = await mkdtemp(resolve('.harness', 'live-assistant-capture-'));
    evidence.fixture = '.harness/' + basename(root);
    const source = join(root, 'source');
    const reuse = join(root, 'reuse');
    await seed(source, [2, 0, null, 4], 6);
    await seed(reuse, [0, 17, null, -8], 9);
    await mkdir(join(source, skillDir, 'scripts'), { recursive: true });
    await writeFile(join(source, skillDir, 'SKILL.md'), [
      '---', 'name: ' + name, 'description: ' + description, '---', '',
      'Use for integer amounts in the same units. Treat null as missing and preserve zero.',
      'Use the run_skill_script tool with name ' + name + ', path ' + script +
        ', and args [input path, output path]. Then use the current task checker.', '',
    ].join('\n'));
    await writeFile(join(source, skillDir, script), [
      "import { readFileSync, writeFileSync } from 'node:fs';",
      'const [input, output] = process.argv.slice(2);',
      "const rows = JSON.parse(readFileSync(input, 'utf8'));",
      "if (!Array.isArray(rows) || !rows.every(row => row === null || Number.isSafeInteger(row))) throw new Error('Expected nullable integers');",
      'writeFileSync(output, JSON.stringify(rows.reduce((sum, row) => sum + (row ?? 0), 0)));', '',
    ].join('\n'));

    const config: Config = {
      dataDir: join(root, 'state'), port: await freePort(), model: modelRef, maxSubagents: 1,
      maxDurationMs: limits.elapsedMs, maxTotalTokens: limits.tokensPerTask, maxReworks: 0,
      web: false, discovery: false, review: false, learning: false,
    };
    let pinnedPath: string | undefined;
    // Keep model-controlled execution inside the synthetic fixture.
    const scope = defineExtension({ name: 'live_capture_scope', hooks: [hook(ToolTask, {
      beforeTool(call) {
        const input = call.arguments;
        if (['task_status', 'task_submit'].includes(call.name) ||
          (call.name === 'read' && typeof input.path === 'string' && (input.path === inputPath || normalize(input.path) === pinnedPath)) ||
          (call.name === 'bash' && (input.command === sourceCommand || call.parent)) ||
          (call.name === 'task_verify' && input.criterionId === 1 && Object.keys(input).length === 1) ||
          (call.name === 'run_skill_script' && input.name === name && input.path === script && JSON.stringify(input.args) === JSON.stringify(args))) return;
        return { block: pinnedPath
          ? 'Use run_skill_script for the pinned Skill with the name, script path and args in the brief.'
          : 'Use the synthetic task commands and file paths in the brief.' };
      },
    })] });
    stage = 'daemon';
    daemon = await serve(config, { models, extensions: [scope] });
    const { request } = createClient(config);
    const taskUrl = (id: string) => '/v1/tasks/' + id;
    const catalog = async () => (await request<SkillCatalogEntry[]>('/v1/settings/skills?' + new URLSearchParams({ workspace: reuse })))
      .find(entry => entry.name === name);

    const wait = async (label: string, id: string, target: TaskStatus['status']) => {
      for (;;) {
        deadline.throwIfAborted();
        const current = await request<TaskStatus>(taskUrl(id));
        statuses.set(label, current);
        if (current.status === target) return current;
        assert(!failureStates.includes(current.status), 'Task reached a terminal state early.');
        await sleep(250, undefined, { signal: deadline });
      }
    };
    const prepare = async (label: string, workspace: string, instruction: string, skills: Array<{ name: string; version: string }>) => {
      const objective = 'Calculate the synthetic invoice total in ' + resultPath + '. ' + instruction + '\n' +
        'Your very first action must be the task_prepare tool call. The check specification is complete below. Do not read files or list the directory in this preparation turn. Set exactly one criterion with method "check" and verification ' + JSON.stringify(verification) + '. ' +
        'Set deliverables to ["deliverables"], inputs to ["acceptance","input.json"], scope to ["synthetic workspace only"], and assumptions and questions to []. Await user confirmation. ' +
        'Once confirmed, run the requested script, call task_verify with {"criterionId":1}, ' +
        'then task_submit with artifacts ["deliverables"] and the passing criterion 1 using the returned receipt ID in proofIds.';
      const task = await request<TaskMeta>('/v1/tasks', 'POST', { objective, workspace, skills });
      const ready = await wait(label, task.id, 'awaiting_confirmation');
      assert.equal(ready.goal?.brief?.criteria.length, 1);
      assert.equal(ready.goal.brief.criteria[0]?.method, 'check');
      const check = ready.goal.brief.criteria[0]?.verification;
      const reuseFileOnly = label === 'reuse' && check?.outputs.length === 1 && check.outputs[0] === resultPath;
      assert.deepEqual(check, { ...verification, outputs: reuseFileOnly ? [resultPath] : verification.outputs },
        'Preserve the checker and its original inputs. The source check must cover the captured Skill.');
      assert.ok(ready.briefDigest);
      return ready;
    };
    const finish = async (label: string, ready: TaskStatus, workspace: string, expected: number) => {
      await request(taskUrl(ready.id) + '/confirm', 'POST', { revision: ready.goal!.brief!.revision, digest: ready.briefDigest });
      const done = await wait(label, ready.id, 'completed');
      assert.equal(done.goal?.verification?.result.verdict, 'pass');
      assert.equal(JSON.parse(await readFile(join(workspace, resultPath), 'utf8')), expected);
      const proofId = done.goal?.candidate?.criteria?.find(criterion => criterion.id === 1)?.proofIds?.[0];
      assert(proofId && done.goal?.proofs?.[proofId]?.passed);
      return { done, proofId };
    };

    stage = 'prepare_source';
    const first = await prepare('source', source, 'After confirmation, call bash with the exact command ' + JSON.stringify(sourceCommand) + '.', []);
    stage = 'verify_source';
    const { done: delivered, proofId } = await finish('source', first, source, 6);
    assert(delivered.messages.some(message => message.role === 'toolResult' && message.toolName === 'bash' && !message.isError));
    assert.equal(await catalog(), undefined);
    evidence.source = { result: 6, frozenCheck: true };

    stage = 'owner_capture';
    const requestsBeforeCapture = requests;
    const ref = await request<{ name: string; version: string }>(taskUrl(first.id) + '/skills/capture', 'POST', { path: skillDir });
    assert.equal(ref.name, name);
    assert.match(ref.version, /^[0-9a-f]{64}$/);
    const entry = await catalog();
    assert(entry?.enabled && entry.source === 'managed' && entry.currentVersion === ref.version);
    assert.equal(entry.description, description);
    const provenance = JSON.parse(await readFile(join(config.dataDir, 'skills', 'managed', name, ref.version + '.source.json'), 'utf8'));
    assert.equal(provenance.taskId, first.id);
    assert.equal(provenance.proofId, proofId);
    assert.deepEqual(provenance.inputHashes, delivered.goal!.proofs![proofId]!.inputs);
    assert.equal(requests, requestsBeforeCapture);
    evidence.capture = { ...ref, sourceReceiptMatched: true, modelRequests: 0 };

    stage = 'pin_new_task';
    const second = await prepare('reuse', reuse, 'After confirmation, call task_status to get the pinned ' + name +
      ' SKILL.md path, read it, then call run_skill_script with name ' + name + ', path ' + script + ', and args ' + JSON.stringify(args) + '.', [ref]);
    const pin = second.skillPins?.pins.find(pin => pin.name === name);
    assert(pin?.managed && pin.version === ref.version);
    pinnedPath = pin.filePath;
    stage = 'owner_rollback';
    await request('/v1/settings/skills/rollback', 'POST', ref);
    const rolledBack = await catalog();
    assert(rolledBack && !rolledBack.enabled);
    await assert.rejects(request('/v1/tasks', 'POST', { objective: 'Disabled Skill must be unavailable for new selections.', workspace: reuse, skills: [ref] }), /disabled/i);
    evidence.rollback = { disabledForNewTasks: true };

    stage = 'verify_pinned_reuse';
    const { done: reused } = await finish('reuse', second, reuse, 9);
    const skills = reused.goal?.skills;
    assert.deepEqual(skills?.pins, [pin]);
    assert(skills?.loaded.includes(name + '@' + ref.version));
    assert.equal(skills.executions?.length, 1);
    const execution = skills.executions[0];
    assert(execution?.ok && execution.version === ref.version && execution.path === script);
    evidence.reuse = { result: 9, frozenCheck: true, version: ref.version, read: true, scriptDurationMs: execution.durationMs };
    stage = 'complete';
    passed = true;
  } catch {
    process.stderr.write('F18 stopped at ' + stage + '.\n');
  } finally {
    abort.abort();
    if (daemon) await daemon.close().catch(() => { stage = 'shutdown'; passed = false; });
    const tasks = Object.fromEntries([...statuses].map(([label, task]) => [label, {
      status: task.status, compactions: task.compactions, reworks: task.goal?.reworks,
      inputTokens: task.budget.inputTokens, outputTokens: task.budget.outputTokens, totalTokens: task.budget.totalTokens,
      toolErrors: task.messages.flatMap(message => message.role === 'toolResult' && message.isError ? [message.toolName] : []),
    }]));
    console.log(JSON.stringify({ id: 'F18', ...modelRef, passed, stage, evidence, limits, modelRequests: requests,
      elapsedMs: Date.now() - started, usage, money: null, tasks }, null, 2));
    if (!passed) process.exitCode = 1;
  }
}

await main();
