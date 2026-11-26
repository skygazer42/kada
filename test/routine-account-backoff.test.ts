import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import test from 'node:test';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { modelAccountRefusal } from '../src/routine-account-backoff.js';
import { LocalRoutines, type RoutineInput, type Routine, type RoutineHistoryRecord, type RoutineOccurrenceRecord } from '../src/routines.js';
import { serve } from '../src/server.js';
import { createClient } from '../src/client.js';
import { fakeRoutineClock, scriptedFixture, until } from './helpers.js';

const minute = 60_000, start = Date.parse('2026-11-25T12:00:00Z');
const rule = { id: 'account', action: 'task', objective: 'Check the approved project',
  schedule: { kind: 'interval', anchorAt: new Date(start + minute).toISOString(), everyMinutes: 5 },
  accountBackoff: true } satisfies RoutineInput;
const error = (text: string) => fauxAssistantMessage('', { stopReason: 'error', errorMessage: text });

test('only explicit nonretryable Pi model account errors trigger routine backoff', () => {
  for (const [message, code] of [
    ['401 Unauthorized: Invalid API key', 'auth'], ['403: model access denied', 'access'],
    ['402 Payment Required', 'quota'], ['429 {"error":{"code":"insufficient_quota"}}', 'quota'],
    ['404: model not found', 'model'], ['No API key for provider: example', 'auth'],
  ]) assert.equal(modelAccountRefusal(error(message!)), code);
  for (const message of ['429 rate limit exceeded', '503 temporarily unavailable', 'fetch failed',
    '400 context_length_exceeded', '400 invalid_request_error', 'request id abc401def', 'Unknown provider failure']) {
    assert.equal(modelAccountRefusal(error(message)), undefined, message);
  }
  assert.equal(modelAccountRefusal(fauxAssistantMessage('401 Unauthorized')), undefined);
  assert.equal(modelAccountRefusal(fauxAssistantMessage('', { stopReason: 'aborted', errorMessage: '401 Unauthorized' })), undefined);
});

test('account cooldown skips before precheck, survives reopen and clears only after a successful manual task', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'kada-account-'));
  const clock = fakeRoutineClock(start);
  let failures = 0, succeeded = false;
  const tasks: string[] = [];
  const options = { dataDir, ...clock,
    execute: async (occurrence: { taskId: string }) => { tasks.push(occurrence.taskId); return { taskId: occurrence.taskId }; },
    taskOverview: async () => ({ status: succeeded ? 'completed' as const : 'failed' as const, reason: null, question: null, summary: null,
      ...(!succeeded ? { modelRefusal: { code: 'auth' as const, at: start + (failures === 0 ? 1 : 6) * minute, submissionId: failures + 1 } } : {}) }),
  };
  let routines = new LocalRoutines(options);
  t.after(async () => { await routines.close(); await rm(dataDir, { recursive: true, force: true, maxRetries: 5 }); });
  const input = { ...rule, workspace: dataDir,
    precheck: { command: [process.execPath, '-e', "require('node:fs').appendFileSync('samples.txt','sample\\n');console.log(Date.now())"] } };
  const slot = async (at: number) => {
    await until(async () => clock.waitingAt(at), Boolean); clock.advanceTo(at);
    return until(async () => (await routines.history(rule.id)).find(row => row.scheduledAt === new Date(at).toISOString() && row.status !== 'claimed'), Boolean);
  };
  await routines.create(input);
  assert.equal((await slot(start + minute))?.status, 'started');
  assert.equal((await slot(start + 6 * minute))?.status, 'started'); failures = 1;
  assert.equal((await slot(start + 11 * minute))?.status, 'skipped');
  assert.equal((await routines.list())[0].accountCooldown?.failures, 2);
  const originalUntil = (await routines.list())[0].accountCooldown!.until;
  assert.equal(originalUntil, start + 16 * minute);
  assert.equal(await readFile(join(dataDir, 'samples.txt'), 'utf8'), 'sample\nsample\n');
  await routines.close(); routines = new LocalRoutines(options); await routines.recover();
  await routines.update(rule.id, { ...input, objective: 'Updated approved project checklist' });
  await routines.pause(rule.id); await routines.resume(rule.id);
  assert.equal((await routines.list())[0].accountCooldown?.until, originalUntil);
  const manual = await routines.runNow(rule.id, 'check-repaired-account');
  await until(() => routines.history(rule.id), rows => rows.some(row => row.id === manual.id && row.status === 'started'));
  assert.equal((await routines.list())[0].accountCooldown?.failures, 2, 'admission alone cannot clear account failure');
  succeeded = true;
  assert.equal((await slot(start + 16 * minute))?.status, 'started');
  assert.equal((await routines.list())[0].accountCooldown, undefined);
  assert.equal(tasks.length, 4);
});

test('the owner API gates real Pi final model errors across daemon reopen and manual repair', async t => {
  const initial = Date.now(), clock = fakeRoutineClock(initial);
  let calls = 0, repaired = false;
  const fixture = await scriptedFixture(() => {
    calls++;
    return repaired ? fauxAssistantMessage(fauxToolCall('task_submit', { summary: 'Checked', artifacts: [] }), { stopReason: 'toolUse' }) :
      { ...error('401 Unauthorized: synthetic invalid API key'), timestamp: clock.now() };
  }, {}, () => [], { routineClock: clock });
  const socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const settings = { ...fixture.settings, port }, client = createClient(settings), options = { models: fixture.models, routineClock: clock };
  let server = await serve(settings, options), runtime = server.runtime;
  t.after(async () => { await server.close(); await fixture.close(); });
  const input = { ...rule, workspace: fixture.workspace,
    schedule: { kind: 'interval', anchorAt: new Date(initial + minute).toISOString(), everyMinutes: 5 } };
  assert.equal((await fetch(`http://127.0.0.1:${port}/v1/routines`, { method: 'POST', body: JSON.stringify(input) })).status, 401);
  await client.request('/v1/routines', 'POST', input);
  const history = () => client.request<RoutineHistoryRecord[]>(`/v1/routines/${rule.id}/occurrences`);
  const slot = async (at: number) => {
    await until(async () => clock.waitingAt(at), Boolean); clock.advanceTo(at);
    const receipt = await until(async () => (await history()).find(row => row.scheduledAt === new Date(at).toISOString() && row.status !== 'claimed'), Boolean);
    if (receipt?.status === 'started') await until(() => runtime.status(receipt.taskId!), row => row.status === (repaired ? 'completed' : 'failed'));
    return receipt;
  };
  await slot(initial + minute); await slot(initial + 6 * minute);
  await server.close(); server = await serve(settings, options); runtime = server.runtime;
  const skip = await slot(initial + 11 * minute);
  assert.equal(skip?.status, 'skipped'); assert.equal(calls, 2);
  assert.equal((await client.request<Routine[]>('/v1/routines'))[0].accountCooldown?.failures, 2);
  assert.equal(JSON.stringify(await history()).includes('synthetic invalid API key'), false);
  repaired = true;
  const manual = await client.request<RoutineOccurrenceRecord>(`/v1/routines/${rule.id}/run`, 'POST', { requestId: 'repaired' });
  await until(history, rows => rows.some(row => row.id === manual.id && row.status === 'started'));
  await until(() => runtime.status(manual.taskId!), row => row.status === 'completed');
  assert.equal((await slot(initial + 16 * minute))?.status, 'started');
  assert.equal((await runtime.routines.list())[0].accountCooldown, undefined);
  assert.equal(calls, 4);
});

test('account policy rejects unsupported configurations and defaults to no backoff', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'kada-account-config-'));
  const routines = new LocalRoutines({ dataDir, execute: async occurrence => ({ taskId: occurrence.taskId }) });
  t.after(async () => { await routines.close(); await rm(dataDir, { recursive: true, force: true, maxRetries: 5 }); });
  for (const input of [rule, { ...rule, workspace: dataDir, accountBackoff: false },
    { ...rule, workspace: dataDir, action: 'notify' },
    { ...rule, workspace: dataDir, schedule: { kind: 'once', at: new Date(start + minute).toISOString() } },
    { ...rule, workspace: dataDir, schedule: { kind: 'event' }, event: { source: 'test', type: 'new', equals: { ok: true } } },
    { ...rule, workspace: dataDir, event: { source: 'test', type: 'new', equals: { ok: true } } },
  ]) await assert.rejects(routines.create(input as RoutineInput), { status: 400 });
  const { accountBackoff: _backoff, ...ordinary } = rule;
  assert.equal((await routines.create({ ...ordinary, workspace: dataDir })).accountBackoff, undefined);
});

test('the cap is one day and late results from old revisions cannot add failures', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'kada-account-cap-')), clock = fakeRoutineClock(start);
  let at = start, submissionId = 0;
  const routines = new LocalRoutines({ dataDir, ...clock,
    execute: async occurrence => ({ taskId: occurrence.taskId }),
    taskOverview: async () => ({ status: 'failed', reason: null, question: null, summary: null,
      modelRefusal: { code: 'quota', at, submissionId } }),
  });
  t.after(async () => { await routines.close(); await rm(dataDir, { recursive: true, force: true, maxRetries: 5 }); });
  const input = { ...rule, workspace: dataDir };
  await routines.create(input);
  for (let count = 1; count <= 12; count++) {
    const manual = await routines.runNow(rule.id, 'failure-' + count);
    await until(() => routines.history(rule.id), rows => rows.some(row => row.id === manual.id && row.status === 'started'));
    at = clock.now(); submissionId = count;
    const inspect = await routines.runNow(rule.id, 'inspect-' + count);
    await until(() => routines.history(rule.id), rows => rows.some(row => row.id === inspect.id && row.status === 'started'));
    const cooldown = (await routines.list())[0].accountCooldown!;
    assert(cooldown.until - at <= 86_400_000);
  }
  const before = (await routines.list())[0].accountCooldown!;
  assert.equal(before.until - at, 86_400_000);
  await routines.update(rule.id, { ...input, objective: 'New revision' });
  at = start + minute; submissionId++;
  await until(async () => clock.waitingAt(start + minute), Boolean); clock.advanceTo(start + minute);
  await until(() => routines.history(rule.id), rows => rows.some(row => row.status === 'skipped'));
  assert.deepEqual((await routines.list())[0].accountCooldown, before, 'late old revision results do not mutate the saved cooldown');
});

test('observing the same failed task across scheduled checks and reopen never extends its cooldown', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'kada-account-repeat-')), clock = fakeRoutineClock(start);
  let calls = 0, failedAt = start;
  const options = { dataDir, ...clock,
    execute: async (occurrence: { taskId: string }) => { calls++; failedAt = clock.now(); return { taskId: occurrence.taskId }; },
    taskOverview: async () => ({ status: 'failed' as const, reason: null, question: null, summary: null,
      modelRefusal: { code: 'auth' as const, at: failedAt, submissionId: 1 } }),
  };
  let routines = new LocalRoutines(options);
  t.after(async () => { await routines.close(); await rm(dataDir, { recursive: true, force: true, maxRetries: 5 }); });
  await routines.create({ ...rule, workspace: dataDir });
  const slot = async (minutes: number) => {
    const at = start + minutes * minute;
    await until(async () => clock.waitingAt(at), Boolean); clock.advanceTo(at);
    return until(async () => (await routines.history(rule.id)).find(row => row.scheduledAt === new Date(at).toISOString() && row.status !== 'claimed'), Boolean);
  };
  for (const minutes of [1, 6, 11, 16]) await slot(minutes);
  assert.equal(calls, 3);
  const firstSkip = await slot(21);
  assert.equal(firstSkip?.accountCooldown?.failures, 3);
  assert.equal(firstSkip?.accountCooldown?.until, start + 36 * minute);
  await routines.close(); routines = new LocalRoutines(options); await routines.recover();
  for (const minutes of [26, 31]) {
    const skip = await slot(minutes);
    assert.deepEqual(skip?.accountCooldown, firstSkip.accountCooldown);
  }
  assert.equal(calls, 3);
});

test('ordinary rules keep their cadence and transient model errors remain owned by Pi retries', async t => {
  for (const enabled of [false, true]) {
    const initial = Date.now(), clock = fakeRoutineClock(initial);
    let calls = 0;
    const fixture = await scriptedFixture(() => {
      calls++;
      if (!enabled) return error('401 Unauthorized: synthetic invalid API key');
      if (calls % 2) return error('429 rate limit exceeded');
      return fauxAssistantMessage(fauxToolCall('task_submit', { summary: 'Checked after Pi retry', artifacts: [] }), { stopReason: 'toolUse' });
    }, {}, () => [], { routineClock: clock });
    try {
      const { accountBackoff: _backoff, ...ordinary } = rule;
      await fixture.runtime.routines.create({ ...ordinary, ...(enabled ? { accountBackoff: true as const } : {}), workspace: fixture.workspace,
        schedule: { kind: 'interval', anchorAt: new Date(initial + minute).toISOString(), everyMinutes: 5 } });
      for (const at of [initial + minute, initial + 6 * minute]) {
        await until(async () => clock.waitingAt(at), Boolean); clock.advanceTo(at);
        const receipt = await until(async () => (await fixture.runtime.routines.history(rule.id)).find(row => row.status === 'started' && row.scheduledAt === new Date(at).toISOString()), Boolean);
        await until(() => fixture.runtime.status(receipt!.taskId!), row => row.status === (enabled ? 'completed' : 'failed'));
      }
      assert.equal(calls, enabled ? 4 : 2);
      assert.equal((await fixture.runtime.routines.list())[0].accountCooldown, undefined);
    } finally { await fixture.close(); }
  }
});
