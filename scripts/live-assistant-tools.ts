import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { stdin } from 'node:process';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createModels, createProvider } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import type { Config } from '../src/config.js';
import { cloudModels } from '../src/models.js';
import { LocalRuntime } from '../src/runtime.js';

const limits = { requests: 32, maxOutputTokens: 768, elapsedMs: 480_000 };
const defaultModelId = 'Qwen/Qwen2.5-7B-Instruct';
const selected = { provider: 'siliconflow', modelId: process.env.SILICONFLOW_MODEL?.trim() || defaultModelId };
const previous = { provider: selected.provider, modelId: 'fixture-previous-selection' };
const reportPath = fileURLToPath(new URL('../docs/experiments/2026-11-23-assistant-tools.json', import.meta.url));
const fixtureParent = fileURLToPath(new URL('../.harness/', import.meta.url));
type Status = Awaited<ReturnType<LocalRuntime['status']>>;
type Metrics = { inputTokens: number; outputTokens: number; totalTokens: number; money: null };
type Stage =
  | 'create_previous_task' | 'check_provider' | 'select_model' | 'create_selected_task' | 'check_model_pins'
  | 'configure_mcp' | 'discover_mcp' | 'enable_mcp' | 'create_mcp_task' | 'await_completion' | 'check_mcp_output'
  | 'check_mcp_calls' | 'disable_mcp' | 'prepare_skill_input' | 'create_skill_task' | 'check_skill_output'
  | 'check_skill_pin' | 'check_skill_read' | 'check_skill_execution' | 'check_reused_version';
type Check = {
  id: string; passed: boolean; requests: number; elapsedMs: number;
  evidence?: Record<string, unknown>; reason?: string; stage?: Stage;
};

async function credential(): Promise<string> {
  const configured = process.env.SILICONFLOW_API_KEY?.trim();
  delete process.env.SILICONFLOW_API_KEY;
  if (configured) return configured;
  if (!stdin.isTTY) throw new Error('A SiliconFlow credential is required.');
  const raw = stdin.isRaw === true;
  stdin.setRawMode(true);
  const input = createInterface({ input: stdin, terminal: false });
  try {
    process.stdout.write('READY_FOR_CREDENTIAL\n');
    const key = await new Promise<string>(resolve => {
      input.once('line', resolve);
      input.once('close', () => resolve(''));
    });
    if (!key.trim()) throw new Error('A SiliconFlow credential is required.');
    return key.trim();
  } finally {
    input.close();
    stdin.setRawMode(raw);
    stdin.pause();
  }
}

function countRequest(deadline: AbortSignal, signal?: AbortSignal): AbortSignal {
  deadline.throwIfAborted();
  signal?.throwIfAborted();
  if (counts.requests >= limits.requests) throw new Error('Model request is outside the smoke budget.');
  counts.requests++;
  return signal ? AbortSignal.any([deadline, signal]) : deadline;
}

async function guardedModels(apiKey: string, deadline: AbortSignal) {
  const catalog = cloudModels();
  const configured = catalog.getModel(selected.provider, selected.modelId);
  const model = configured ?? catalog.getModel(selected.provider, defaultModelId);
  if (!model || model.api !== 'openai-completions') throw new Error('The production SiliconFlow model template is unavailable.');
  if (selected.modelId === previous.modelId) throw new Error('Choose a valid SiliconFlow model ID.');
  if (!configured) {
    const response = await fetch(model.baseUrl + '/models', {
      headers: { Authorization: `Bearer ${apiKey}` }, redirect: 'error', signal: countRequest(deadline),
    });
    if (!response.ok) throw new Error('SiliconFlow catalog lookup failed.');
    const body = await response.json() as { data?: Array<{ id: string }> };
    if (!Array.isArray(body.data) || !body.data.some(item => item?.id === selected.modelId)) {
      throw new Error('The requested model is absent from the authenticated SiliconFlow catalog.');
    }
    customCatalog = true;
  }
  const native = openAICompletionsApi();
  const observe=(stream:ReturnType<typeof native.stream>)=>{
    void stream.result().then(message=>{
      totalUsage.inputTokens+=message.usage.input;totalUsage.outputTokens+=message.usage.output;
      totalUsage.cachedTokens+=message.usage.cacheRead;totalUsage.totalTokens+=message.usage.totalTokens;
    });
    return stream;
  };
  const models = createModels();
  const guard = (requested: string, signal?: AbortSignal) => {
    if (requested !== selected.modelId) throw new Error('Model request is outside the smoke budget.');
    return countRequest(deadline, signal);
  };
  models.setProvider(createProvider({
    id: selected.provider,
    name: 'SiliconFlow',
    baseUrl: model.baseUrl,
    models: [
      { ...model, id: selected.modelId, name: configured?.name ?? selected.modelId, maxTokens: limits.maxOutputTokens },
      { ...model, id: previous.modelId, maxTokens: limits.maxOutputTokens },
    ],
    auth: { apiKey: { name: 'SiliconFlow live', resolve: async () => ({ auth: { apiKey } }) } },
    api: {
      stream: (m, context, options) => observe(native.stream(m, context, {
        ...options,
        maxTokens: Math.min(options?.maxTokens ?? limits.maxOutputTokens, limits.maxOutputTokens),
        signal: guard(m.id, options?.signal),
      })),
      streamSimple: (m, context, options) => observe(native.streamSimple(m, context, {
        ...options,
        maxTokens: Math.min(options?.maxTokens ?? limits.maxOutputTokens, limits.maxOutputTokens),
        signal: guard(m.id, options?.signal),
      })),
    },
  }));
  return models;
}

const mcpServer = `
  const { appendFileSync, writeFileSync } = require('node:fs');
  const input = require('node:readline').createInterface({ input: process.stdin });
  input.on('line', line => {
    const request = JSON.parse(line);
    if (request.id === undefined) return;
    let result;
    if (request.method === 'initialize') result = {
      protocolVersion: request.params.protocolVersion,
      serverInfo: { name: 'sum-fixture', version: '1' }, capabilities: { tools: {} },
    };
    if (request.method === 'tools/list') result = { tools: [{
      name: 'sum', description: 'Add left and right. Write the result to mcp-result.json.',
      inputSchema: { type: 'object', properties: { left: { type: 'integer' }, right: { type: 'integer' } },
        required: ['left', 'right'], additionalProperties: false },
    }] };
    if (request.method === 'tools/call') {
      const { left, right } = request.params.arguments;
      if (request.params.name !== 'sum' || !Number.isInteger(left) || !Number.isInteger(right)) return;
      appendFileSync(process.argv[2], JSON.stringify([left, right]) + '\\n');
      writeFileSync(process.argv[1], JSON.stringify(left + right));
      result = { content: [{ type: 'text', text: String(left + right) }] };
    }
    console.log(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
  });
`;

const pinName = 'fixture-sum';
const skill = `---
name: ${pinName}
description: Add the integers from a JSON array and write the sum to a JSON file.
---

Run the pinned scripts/sum.mjs using run_skill_script. Pass exactly two
relative arguments, the input JSON path and the output JSON path. Then
submit the result with task_submit. The script is responsible for the arithmetic.
`;
const skillScript = `
  import { readFileSync, writeFileSync } from 'node:fs';
  const [input, output] = process.argv.slice(2);
  const numbers = JSON.parse(readFileSync(input, 'utf8'));
  if (!Array.isArray(numbers) || !numbers.every(Number.isInteger)) throw new Error('Expected integers');
  writeFileSync(output, JSON.stringify(numbers.reduce((sum, number) => sum + number, 0)));
`;

const acceptance = (path: string, equals: number) => [{ type: 'json_value', path, pointer: '', equals }];

async function complete(runtime: LocalRuntime, id: string, deadline: AbortSignal): Promise<Status> {
  while (true) {
    deadline.throwIfAborted();
    const task = await runtime.status(id);
    if (task.status === 'completed') return task;
    if (['failed', 'cancelled', 'blocked', 'stopped', 'paused'].includes(task.status)) {
      throw new Error('The local task ended before verification.');
    }
    await sleep(250, undefined, { signal: deadline });
  }
}

function usage(task: Status): Metrics {
  const { inputTokens, outputTokens, totalTokens } = task.budget;
  return { inputTokens, outputTokens, totalTokens, money: null };
}

const counts = { requests: 0 };
const totalUsage={inputTokens:0,outputTokens:0,cachedTokens:0,totalTokens:0};
const checks: Check[] = [];
const started = Date.now();
let customCatalog = false;
let preservedFixture: string | undefined;

async function report(setupFailed: boolean): Promise<void> {
  for (const id of ['F08', 'F10', 'F09', 'F18']) {
    if (!checks.some(item => item.id === id)) {
      checks.push({ id, passed: false, requests: 0, elapsedMs: 0, reason: 'The fixture did not reach this check.' });
    }
  }
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify({
    provider: selected.provider, model: selected.modelId, customCatalog, limits, money: null,
    ...(preservedFixture ? { fixture: preservedFixture } : {}),
    requests: counts.requests, elapsedMs: Date.now() - started, setupFailed, checks,totalUsage,
  }, null, 2) + '\n');
}

async function check(id: string, reason: string, action: (at: (stage: Stage) => void) => Promise<Record<string, unknown>>): Promise<void> {
  const started = Date.now();
  const requestsBefore = counts.requests;
  let stage: Stage | undefined;
  let result: Pick<Check, 'passed' | 'evidence' | 'reason' | 'stage'>;
  try {
    result = { passed: true, evidence: await action(current => { stage = current; }) };
  } catch {
    result = { passed: false, reason, stage };
  }
  checks.push({ id, ...result, requests: counts.requests - requestsBefore, elapsedMs: Date.now() - started });
  process.stdout.write(`${id} ${result.passed ? 'passed' : 'failed'}\n`);
}

async function main(): Promise<void> {
  const key = await credential();
  const deadline = AbortSignal.timeout(limits.elapsedMs);
  const models = await guardedModels(key, deadline);
  await mkdir(fixtureParent, { recursive: true });
  const root = await mkdtemp(join(fixtureParent, 'live-assistant-tools-'));
  preservedFixture = '.harness/' + basename(root);
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const config: Config = {
    dataDir: join(root, 'data'), port: 4317, model: previous,
    web: false, discovery: false, review: false, maxSubagents: 2,
    maxTotalTokens: 100_000, maxDurationMs: 180_000,
  };
  const runtime = new LocalRuntime(config, { models });
  let setupFailed = false;
  try {
    await check('F08', 'Model connection, selection or pin verification failed.', async at => {
      at('create_previous_task');
      const before = await runtime.create('Keep a fixture task before selecting the live model.', workspace, [], { prepare: true, skills: [] });
      at('check_provider');
      const tested = await runtime.providers.check(selected, { signal: deadline });
      assert.equal(tested.status, 'available');
      at('select_model');
      await runtime.providers.select(selected);
      at('create_selected_task');
      const after = await runtime.create('Keep a fixture task after selecting the live model.', workspace, [], { prepare: true, skills: [] });
      at('check_model_pins');
      assert.deepEqual((await runtime.status(before.id)).model, previous);
      assert.deepEqual((await runtime.status(after.id)).model, selected);
      return { connection: 'available', newTaskUsesSelection: true, previousTaskKeepsModel: true };
    });

    await check('F10', 'MCP discovery, authorization, call or output verification failed.', async at => {
      const resultFile = join(workspace, 'mcp-result.json');
      const countFile = join(root, 'mcp-calls.jsonl');
      at('configure_mcp');
      await runtime.mcp.configure({ id: 'sum-fixture', transport: 'stdio', command: process.execPath, args: ['-e', mcpServer, resultFile, countFile] });
      at('discover_mcp');
      const discovered = await runtime.mcp.test('sum-fixture', deadline);
      assert.equal(discovered.test?.status, 'ok');
      assert.deepEqual(await runtime.mcp.pins(), []);
      at('enable_mcp');
      await runtime.mcp.enable('sum-fixture', ['sum'], discovered.revision);
      const [tool] = await runtime.mcp.tools();
      assert.ok(tool);
      at('create_mcp_task');
      const task = await runtime.create(
        `Call ${tool.name} exactly once with left=19 and right=23. It writes mcp-result.json. Then call task_submit with a short summary and artifacts: [].`,
        workspace, acceptance('mcp-result.json', 42), { skills: [] },
      );
      at('await_completion');
      const status = await complete(runtime, task.id, deadline);
      at('check_mcp_output');
      assert.equal(JSON.parse(await readFile(resultFile, 'utf8')), 42);
      at('check_mcp_calls');
      const submissions = (await readFile(countFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      assert.deepEqual(submissions, [[19, 23]]);
      at('disable_mcp');
      await runtime.mcp.disable('sum-fixture');
      assert.deepEqual(await runtime.mcp.pins(), []);
      return { discovered: true, explicitlyEnabled: true, calls: submissions.length, result: 42, usage: usage(status) };
    });

    const source = join(workspace, '.pi', 'skills', pinName);
    await mkdir(join(source, 'scripts'), { recursive: true });
    await writeFile(join(source, 'SKILL.md'), skill);
    await writeFile(join(source, 'scripts', 'sum.mjs'), skillScript);
    let firstVersion: string | undefined;
    const runSkill = async (label: string, numbers: number[], expected: number, at: (stage: Stage) => void) => {
      at('prepare_skill_input');
      const input = `${label}-input.json`, output = `${label}-result.json`;
      await writeFile(join(workspace, input), JSON.stringify(numbers));
      at('create_skill_task');
      const task = await runtime.create(
        `Use the pinned ${pinName} Skill. Call task_status to find its pinned SKILL.md path, read that file, ` +
        `then call run_skill_script with name ${pinName}, path scripts/sum.mjs, args ["${input}", "${output}"]. ` +
        'Wait for the script result and call task_submit with a short summary and artifacts: [].',
        workspace, acceptance(output, expected), { skills: [{ name: pinName }] },
      );
      at('await_completion');
      const status = await complete(runtime, task.id, deadline);
      at('check_skill_output');
      assert.equal(JSON.parse(await readFile(join(workspace, output), 'utf8')), expected);
      const pinned = status.goal?.skills;
      at('check_skill_pin');
      const pin = pinned?.pins.find(item => item.name === pinName);
      assert.ok(pin);
      at('check_skill_read');
      assert.ok(pinned?.loaded.includes(`${pinName}@${pin.version}`));
      at('check_skill_execution');
      const executions = pinned?.executions?.filter(item => item.name === pinName);
      assert.equal(executions?.length, 1);
      const execution = executions?.[0];
      assert.ok(execution?.ok && execution.version === pin.version && execution.path === 'scripts/sum.mjs');
      return { version: pin.version, read: true, scriptRuns: 1, scriptDurationMs: execution.durationMs, result: expected, usage: usage(status) };
    };
    await check('F09', 'Skill selection, pinned read, script run or output verification failed.', async at => {
      const evidence = await runSkill('first', [19, 23], 42, at);
      firstVersion = evidence.version;
      return evidence;
    });
    await check('F18', 'Independent Skill reuse or output verification failed.', async at => {
      at('check_reused_version');
      assert.ok(firstVersion);
      const evidence = await runSkill('second', [-3, 20], 17, at);
      at('check_reused_version');
      assert.equal(evidence.version, firstVersion);
      return evidence;
    });
  } catch {
    setupFailed = true;
  } finally {
    await runtime.close().catch(() => { setupFailed = true; });
    if (!setupFailed && checks.every(item => item.passed)) {
      try {
        await rm(root, { recursive: true, force: true });
        preservedFixture = undefined;
      } catch {
        setupFailed = true;
      }
    }
    await report(setupFailed);
  }
  if (setupFailed || checks.some(item => !item.passed)) process.exitCode = 1;
}

void main().catch(async () => {
  process.stderr.write('Assistant tool smoke could not finish. Check fixture setup and credential input.\n');
  await report(true).catch(() => {
    process.stderr.write('Assistant tool smoke report could not be written.\n');
  });
  process.exitCode = 1;
});
