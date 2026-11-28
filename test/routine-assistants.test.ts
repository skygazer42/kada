import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fauxAssistantMessage, fauxToolCall, type ToolResultMessage } from '@earendil-works/pi-ai';
import { LocalRuntime } from '../src/runtime.js';
import type { RoutineInput } from '../src/routines.js';
import { serve } from '../src/server.js';
import { createClient } from '../src/client.js';
import { VERSION } from '../src/version.js';
import { fakeRoutineClock, hasTool, recoveryTestTimeoutMs, scriptedFixture, startRecoveryWorker, until } from './helpers.js';

const start = Date.UTC(2026, 10, 27, 11, 59), minute = 60_000;
const schedule = { kind: 'daily', time: '12:00', timeZone: 'UTC' } as const;
const budget = { maxEstimatedCostUsd: 1, maxDurationMs: 30_000, maxTotalTokens: 10_000 };
const call = (name: string, args: Record<string, unknown>) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' });
const method = (text: string) => '---\nname: routine-proof\ndescription: Apply the original routine evidence method.\n---\n\n' + text + '\n';

test('a scheduled named assistant retains its original method and scope while future occurrences require a current revision', async t => {
  const clock = fakeRoutineClock(start);
  let reads = 0;
  const f = await scriptedFixture(context => {
    const system = JSON.stringify(context.messages.filter(message => message.role === 'system'));
    assert.equal(hasTool(context, 'bash'), false);
    assert.equal(hasTool(context, 'write'), false);
    if (system.includes('NEW_ROUTINE_ROLE_76')) {
      assert.doesNotMatch(system, /<location>/);
      return call('task_submit', { summary: 'New explicitly selected routine role completed.', artifacts: [] });
    }
    assert.match(system, /ORIGINAL_ROUTINE_ROLE_39/);
    const paths = [...new Set([...system.matchAll(/<location>(.*?)<\/location>/g)].map(match => JSON.parse('"' + match[1] + '"')))];
    assert.equal(paths.length, 1);
    const last = context.messages.findLastIndex(message => message.role === 'user');
    const results = context.messages.slice(last).filter((message): message is ToolResultMessage => message.role === 'toolResult');
    const read = results.find(result => result.toolName === 'read');
    if (!read) return call('read', { path: paths[0]! });
    assert.equal(read.isError, false);
    assert.match(JSON.stringify(read), /ORIGINAL_ROUTINE_METHOD_93/);
    reads++;
    if (String(context.messages[last]?.content).includes('Continue with the original method')) {
      return call('task_submit', { summary: 'Original method retained after restart.', artifacts: [] });
    }
    return call('task_blocked', { reason: 'Waiting for the owner evidence.', question: 'Which evidence should I check?' });
  }, {}, () => [], { routineClock: clock });
  let runtime = f.runtime;
  t.after(async () => { await runtime.close(); await f.close(); });
  const source = join(f.workspace, '.kada', 'skills', 'routine-proof');
  await mkdir(source, { recursive: true });
  await writeFile(join(source, 'SKILL.md'), method('ORIGINAL_ROUTINE_METHOD_93'));
  const skill = (await runtime.skillCatalog(f.workspace)).find(skill => skill.name === 'routine-proof')!;
  const role = await runtime.assistants.create({ workspace: f.workspace, name: 'Scheduled researcher',
    instructions: 'ORIGINAL_ROUTINE_ROLE_39', tools: ['read'], skills: [{ name: skill.name, version: skill.currentVersion! }] });
  const assistant = { id: role.id, revision: 1 };
  const input: RoutineInput & { assistant: typeof assistant } = { id: 'named-routine', action: 'task',
    objective: 'Read original project evidence.', workspace: f.workspace, assistant, schedule, budget };
  const rule = await runtime.routines.create(input);
  assert.deepEqual(rule.assistant, assistant);
  await until(async () => clock.waitingAt(start + minute), Boolean);
  clock.advanceTo(start + minute);
  const first = await until(() => runtime.routines.history(rule.id), rows => rows.some(row => row.status === 'started'));
  const original = first.find(row => row.status === 'started')!;
  assert.deepEqual(original.assistant, assistant);
  const taskId = original.taskId!;
  const waiting = await until(() => runtime.status(taskId), row => ['waiting_user', 'failed'].includes(row.status));
  assert.equal(waiting.status, 'waiting_user');
  assert.equal(waiting.assistant?.id, role.id);
  assert.equal(waiting.assistant?.revision, 1);
  await writeFile(join(source, 'SKILL.md'), method('CHANGED_ROUTINE_METHOD_85'));
  const changed = await runtime.assistants.update(role.id, { revision: 1, instructions: 'NEW_ROUTINE_ROLE_76', skills: [] });
  await runtime.close();
  runtime = new LocalRuntime(f.settings, { models: f.models, routineClock: clock });
  await runtime.recover();
  const failed = await runtime.routines.runNow(rule.id, 'stale-assistant');
  const rejected = await until(() => runtime.routines.history(rule.id), rows => rows.some(row => row.id === failed.id && row.status === 'failed'));
  assert.match(rejected.find(row => row.id === failed.id && row.status === 'failed')!.detail!, /revision|assistant/i);
  assert.equal((await runtime.list()).length, 1);
  await runtime.followUp(taskId, 'Continue with the original method.', 'original-method');
  const done = await until(() => runtime.status(taskId), row => ['completed', 'failed'].includes(row.status));
  assert.equal(done.status, 'completed');
  assert.equal(done.assistant?.revision, 1);
  assert.equal(done.maxTotalTokens, budget.maxTotalTokens);
  assert(reads >= 2);
  const updated = await runtime.routines.update(rule.id, { ...input, assistant: { id: role.id, revision: changed.revision } });
  assert.equal(updated.revision, 2);
  const fresh = await runtime.routines.runNow(rule.id, 'new-assistant');
  await until(() => runtime.routines.history(rule.id), rows => rows.some(row => row.id === fresh.id && row.status === 'started'));
  const next = await until(() => runtime.status(fresh.taskId!), row => ['completed', 'failed'].includes(row.status));
  assert.equal(next.status, 'completed');
  assert.equal(next.assistant?.revision, changed.revision);
  assert.deepEqual(await runtime.routines.runNow(rule.id, 'stale-assistant'), failed);
});

test('routine assistant selection rejects foreign or invalid roles and replays original save receipts after role edits', async t => {
  const f = await scriptedFixture(() => fauxAssistantMessage('Unused.'));
  t.after(() => f.close());
  const runtime = f.runtime;
  const role = await runtime.assistants.create({ workspace: f.workspace, name: 'Routine reader', instructions: 'Read original evidence.', tools: ['read'] });
  const other = join(f.directory, 'foreign-project');
  await mkdir(other);
  const foreign = await runtime.assistants.create({ workspace: other, name: 'Foreign reader', instructions: 'Private scope.', tools: ['read'] });
  const assistant = { id: role.id, revision: 1 };
  const input = { id: 'saved-role', action: 'task', objective: 'Read the project.', workspace: f.workspace,
    assistant, schedule, budget } as const;
  const invalid = [
    { ...input, id: 'notification', action: 'notify', budget: undefined },
    { ...input, id: 'no-workspace', workspace: undefined },
    { ...input, id: 'foreign-role', assistant: { id: foreign.id, revision: 1 } },
    { ...input, id: 'future-role', assistant: { id: role.id, revision: 2 } },
    { ...input, id: 'malformed-role', assistant: { id: role.id, revision: 0 } },
  ];
  for (const value of invalid) await assert.rejects(runtime.routines.create(value as RoutineInput), /assistant|workspace|revision|local|task/i);
  assert.equal((await runtime.routines.list()).length, 0);
  const saved = await runtime.routines.create(input);
  const edit = { expectedRevision: 1, requestId: 'same-original-edit' };
  const updated = await runtime.routines.update(saved.id, input, edit);
  await runtime.assistants.update(role.id, { revision: 1, archived: true });
  assert.deepEqual(await runtime.routines.create(input), updated);
  assert.deepEqual(await runtime.routines.update(saved.id, input, edit), updated);
  await assert.rejects(runtime.routines.create({ ...input, id: 'archived-role' }), /assistant|revision|archived/i);
  const cleared = await runtime.routines.update(saved.id, { action: 'task', objective: input.objective, workspace: f.workspace, schedule, budget });
  assert.equal(cleared.assistant, undefined);
});

test('changing an assistant while its routine waits in the runtime queue prevents model dispatch', async t => {
  let modelCalls = 0;
  const f = await scriptedFixture(() => { modelCalls++; return call('task_submit', { summary: 'Unexpected execution.', artifacts: [] }); });
  t.after(() => f.close());
  const runtime = f.runtime;
  const role = await runtime.assistants.create({ workspace: f.workspace, name: 'Queued reader', instructions: 'Original queued role.', tools: ['read'] });
  const rule = await runtime.routines.create({ id: 'queued-role', action: 'task', objective: 'Check original evidence.', workspace: f.workspace,
    assistant: { id: role.id, revision: 1 }, schedule, budget });
  const release = Promise.withResolvers<void>();
  const queue = (runtime as unknown as { changes: { run<T>(change: () => Promise<T>): Promise<T> } }).changes;
  const ahead = queue.run(() => release.promise);
  const create = runtime.create.bind(runtime);
  let pending: ReturnType<typeof runtime.create> | undefined;
  runtime.create = (...args) => { pending = create(...args); void pending.catch(() => {}); return pending; };
  try {
    const occurrence = await runtime.routines.runNow(rule.id, 'queued-original');
    await until(async () => Boolean(pending), Boolean);
    await runtime.assistants.update(role.id, { revision: 1, archived: true });
    release.resolve();
    await ahead;
    await assert.rejects(pending!, /assistant|revision|archived/i);
    const history = await until(() => runtime.routines.history(rule.id), rows => rows.some(row => row.id === occurrence.id && row.status === 'failed'));
    assert.match(history.find(row => row.id === occurrence.id && row.status === 'failed')!.detail!, /assistant|revision|archived/i);
    assert.equal(modelCalls, 0);
    assert.equal((await runtime.list()).length, 0);
  } finally { release.resolve(); await ahead; }
});

test('an assistant revision changed after selection is rechecked before the routine task is saved', async t => {
  let modelCalls = 0;
  const f = await scriptedFixture(() => { modelCalls++; return call('task_submit', { summary: 'Unexpected execution.', artifacts: [] }); });
  t.after(() => f.close());
  const runtime = f.runtime;
  const role = await runtime.assistants.create({ workspace: f.workspace, name: 'Admission reader', instructions: 'Original admission role.', tools: ['read'] });
  const rule = await runtime.routines.create({ id: 'admission-role', action: 'task', objective: 'Check original evidence.', workspace: f.workspace,
    assistant: { id: role.id, revision: 1 }, schedule, budget });
  const select = runtime.assistants.select.bind(runtime.assistants);
  let selections = 0;
  runtime.assistants.select = async (...args) => {
    const original = await select(...args);
    if (++selections === 1) await runtime.assistants.update(role.id, { revision: 1, instructions: 'Changed after the original selection.' });
    return original;
  };
  const occurrence = await runtime.routines.runNow(rule.id, 'changed-during-admission');
  await until(() => runtime.routines.history(rule.id), rows => rows.some(row => row.id === occurrence.id && row.status === 'failed'));
  assert.equal(selections, 1);
  assert.equal(modelCalls, 0);
  assert.equal((await runtime.list()).length, 0);
});

test('SIGKILL after a named routine task effect retains its original assistant after the catalogue changes', { timeout: recoveryTestTimeoutMs }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'kada-routine-role-')));
  const fixture = new URL('./fixtures/routine-effect-worker.ts', import.meta.url);
  let worker = startRecoveryWorker(fixture, 'create', directory, 'assistant');
  try {
    await worker.ready();
    assert.equal(await worker.stop(), 'SIGKILL');
    assert.equal(await readFile(join(directory, 'workspace', 'labels.txt'), 'utf8'), 'label-1\n');
    worker = startRecoveryWorker(fixture, 'recover', directory, 'assistant');
    const recovered = await worker.complete();
    assert.equal(recovered.type, 'completed');
    assert.equal(recovered.tasks.length, 1);
    assert.equal(recovered.assistantRevision, 1);
    assert.equal(recovered.currentAssistantRevision, 2);
    assert.deepEqual(recovered.history, [['claimed', recovered.tasks[0]], ['started', recovered.tasks[0]]]);
    assert.equal(await readFile(join(directory, 'workspace', 'labels.txt'), 'utf8'), 'label-1\n');
  } finally { await worker.stop(); await rm(directory, { recursive: true, force: true, maxRetries: 5 }); }
});

test('the owner CLI saves and runs the selected routine assistant through the public API', async t => {
  const f = await scriptedFixture(context => {
    assert.match(JSON.stringify(context.messages.filter(message => message.role === 'system')), /CLI_ROUTINE_ROLE_71/);
    assert.equal(hasTool(context, 'bash'), false);
    return call('task_submit', { summary: 'Selected CLI routine role completed.', artifacts: [] });
  });
  await f.runtime.close();
  const socket = createServer();
  await new Promise<void>(done => socket.listen(0, '127.0.0.1', done));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>(done => socket.close(() => done()));
  const config = { ...f.settings, port };
  const host = await serve(config, { models: f.models });
  t.after(async () => { await host.close(); await f.close(); });
  const client = createClient(config);
  assert.equal(await client.healthy('routine-assistants'), true);
  const role = await host.runtime.assistants.create({ workspace: f.workspace, name: 'CLI routine reader',
    instructions: 'CLI_ROUTINE_ROLE_71', tools: ['read'] });
  const assistant = { id: role.id, revision: role.revision };
  const input = { id: 'cli-assistant-routine', action: 'task', objective: 'Inspect the project.', workspace: f.workspace,
    assistant, schedule, budget };
  const configFile = join(f.directory, 'routine-config.json'), inputFile = join(f.directory, 'routine-input.json');
  await writeFile(configFile, JSON.stringify(config));
  await writeFile(inputFile, JSON.stringify(input));
  const cli = async (...args: string[]) => JSON.parse((await promisify(execFile)(process.execPath,
    ['--import', 'tsx', 'src/cli.ts', 'routines', ...args, '--config', configFile], { cwd: process.cwd() })).stdout);
  const saved = await cli('add', inputFile);
  assert.deepEqual(saved.assistant, assistant);
  const listed = await cli('list');
  assert.deepEqual(listed.find((row: { id: string }) => row.id === saved.id).assistant, assistant);
  const accepted = await cli('run', saved.id, 'cli-original');
  await until(() => host.runtime.routines.history(saved.id), rows => rows.some(row => row.id === accepted.id && row.status === 'started'));
  const done = await until(() => host.runtime.status(accepted.taskId), row => ['completed', 'failed'].includes(row.status));
  assert.equal(done.status, 'completed');
  assert.equal(done.assistant?.id, role.id);
  assert.deepEqual(await cli('run', saved.id, 'cli-original'), accepted);
  const history = await client.request<{ assistant: unknown }[]>('/v1/routines/' + saved.id + '/occurrences');
  assert(history.every(row => JSON.stringify(row.assistant) === JSON.stringify(assistant)));
});

test('a daemon without routine assistant support is rejected before it can discard the selected role', async t => {
  const f = await scriptedFixture(() => fauxAssistantMessage('Unused.'));
  let posts = 0;
  const old = createServer((req, res) => {
    if (req.url === '/health') res.setHeader('Content-Type', 'application/json').end(JSON.stringify({ status: 'ok', version: VERSION, capabilities: ['ordinary-chat', 'routines'] }));
    else if (req.url === '/v1/tasks' && req.method === 'GET') res.setHeader('Content-Type', 'application/json').end('[]');
    else { posts++; res.writeHead(500).end(); }
  });
  await new Promise<void>(done => old.listen(0, '127.0.0.1', done));
  t.after(async () => { old.closeAllConnections(); await new Promise<void>(done => old.close(() => done())); await f.close(); });
  const config = { ...f.settings, port: (old.address() as { port: number }).port };
  const configFile = join(f.directory, 'old-daemon.json'), inputFile = join(f.directory, 'selected-role.json');
  await writeFile(join(f.directory, 'token'), 'routine-old-daemon-fixture');
  await writeFile(configFile, JSON.stringify(config));
  await writeFile(inputFile, JSON.stringify({ action: 'task', workspace: f.workspace, objective: 'Use the selected role.', schedule, budget,
    assistant: { id: '533fe0dc-d5e2-4f9d-9c21-e64ccff64cdd', revision: 1 } }));
  for (const args of [['add', inputFile], ['update', 'existing-rule', inputFile]]) {
    await assert.rejects(promisify(execFile)(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'routines', ...args, '--config', configFile]), /命名助手执行例行任务/);
  }
  assert.equal(posts, 0);
});
