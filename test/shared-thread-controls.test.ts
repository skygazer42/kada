import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import test from 'node:test';
import { promisify } from 'node:util';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { createClient } from '../src/client.js';
import { serve } from '../src/server.js';
import { hasTool, scriptedFixture, until } from './helpers.js';

test('a paired device confirms and controls the same shared task under its independent grant', async t => {
  const fixture = await scriptedFixture(async (context, signal) => {
    const latest = context.messages.findLast(message => message.role === 'user')?.content;
    if (hasTool(context, 'task_submit') || latest === 'Hold the original chat turn.') {
      await setTimeout(60_000, undefined, { signal });
      return fauxAssistantMessage('The synthetic operation is finished.');
    }
    return fauxAssistantMessage(fauxToolCall('task_prepare', {
      outcome: 'Prepare the original shared operation.', deliverables: ['Original result'], inputs: [],
      criteria: [{ text: 'Record the selected sample.', method: 'inspect' }], scope: ['Synthetic workspace'],
      assumptions: ['Use the stored original sample.'], questions: [],
      budget: { maxEstimatedCostUsd: 1, maxDurationMs: 120_000, maxTotalTokens: 16_000 },
    }), { stopReason: 'toolUse' });
  });
  await fixture.runtime.close();
  const socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const settings = { ...fixture.settings, port };
  let server = await serve(settings, { models: fixture.models });
  t.after(async () => { await server.close(); await fixture.close(); });
  const client = createClient(settings);
  const task = await server.runtime.create('Do the original operation.', fixture.workspace, [], { prepare: true });
  await until(() => server.runtime.status(task.id), state => state.status === 'awaiting_confirmation');
  const pair = (deviceId: string) => client.request<{ token: string }>('/v1/remote/devices', 'POST', { accountId: 'owner', deviceId });
  const phone = await pair('phone'), viewer = await pair('viewer');
  const grant = (action: string, deviceId = 'phone') => client.request(`/v1/tasks/${task.id}/${action}`, 'POST', { accountId: 'owner', deviceId });
  const url = `http://127.0.0.1:${port}/remote/api/shared-threads/${task.id}`;
  const remote = (path = '', body?: unknown, token = phone.token) => fetch(url + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  await assert.rejects(grant('share-thread-controls'), /share.*view/i);
  await grant('share-thread');
  await grant('share-thread', 'viewer');
  const readOnly = await (await remote()).json();
  assert.equal(readOnly.brief, null);
  assert.deepEqual(readOnly.controls, []);
  assert.equal((await remote('/confirm', { revision: 1, digest: '0'.repeat(64) })).status, 403);
  await grant('share-thread-controls');
  const ready = await (await remote()).json();
  assert.equal(ready.id, task.id);
  assert.equal(ready.brief.outcome, 'Prepare the original shared operation.');
  assert.equal(ready.brief.budget.maxTotalTokens, 16_000);
  const confirm = { revision: ready.brief.revision, digest: ready.briefDigest };
  assert.equal((await remote('/confirm', confirm, viewer.token)).status, 403);
  assert.equal((await remote('/confirm', { ...confirm, digest: '0'.repeat(64) })).status, 409);
  assert.equal((await remote('/confirm', confirm)).status, 200);
  const running = await until(() => server.runtime.status(task.id), state => state.status === 'running');
  const original = running.goal!.confirmation!;
  const first = await (await remote()).json();
  assert.equal(first.brief, null);
  assert.deepEqual(first.controls, ['pause', 'cancel']);
  assert.equal((await remote('/confirm', confirm)).status, 200);
  assert.equal((await remote('/control', { action: 'pause', version: first.controlVersion })).status, 200);
  await server.close();
  server = await serve(settings, { models: fixture.models });
  const paused = await (await remote()).json();
  assert.equal(paused.status, 'paused');
  assert.deepEqual(paused.controls, ['continue', 'cancel']);
  assert.equal((await remote('/control', { action: 'continue', version: first.controlVersion })).status, 409);
  assert.equal((await remote('/control', { action: 'continue', version: paused.controlVersion }, viewer.token)).status, 403);
  assert.equal((await remote('/control', { action: 'continue', version: paused.controlVersion })).status, 200);
  const continued = await until(() => server.runtime.status(task.id), state => state.status === 'running');
  assert.deepEqual(continued.goal?.confirmation, original);
  assert.equal(continued.goal?.tokenLimit, running.goal?.tokenLimit);
  assert.equal(continued.submission?.id, running.submission?.id);
  const version = (await (await remote()).json()).controlVersion;
  await server.runtime.pause(task.id);
  assert.deepEqual((await (await remote()).json()).controls, []);
  await server.runtime.resume(task.id);
  const afterHostResume = await (await remote()).json();
  assert.notEqual(afterHostResume.controlVersion, version);
  assert.equal((await remote('/control', { action: 'cancel', version })).status, 409);
  await grant('unshare-thread-controls');
  assert.equal((await remote('/control', { action: 'cancel', version: afterHostResume.controlVersion })).status, 403);
  assert.equal((await remote()).status, 200);
  await grant('share-thread-controls');
  assert.equal((await remote('/control', { action: 'cancel', version: afterHostResume.controlVersion })).status, 200);
  assert.equal((await server.runtime.status(task.id)).status, 'cancelled');
  await grant('unshare-thread');
  await grant('share-thread');
  assert.deepEqual((await (await remote()).json()).controls, []);

  const ordinary = await server.runtime.create('Hold the original chat turn.', fixture.workspace, [], { chat: true });
  await until(() => server.runtime.status(ordinary.id), state => state.status === 'running');
  for (const action of ['share-thread', 'share-thread-controls']) {
    await client.request(`/v1/tasks/${ordinary.id}/${action}`, 'POST', { accountId: 'owner', deviceId: 'phone' });
  }
  const originalChatUrl = url.replace(task.id, ordinary.id);
  const headers = { Authorization: `Bearer ${phone.token}`, 'Content-Type': 'application/json' };
  const stale = await (await fetch(originalChatUrl, { headers })).json();
  await server.runtime.pause(ordinary.id);
  await server.runtime.resume(ordinary.id);
  await until(() => server.runtime.status(ordinary.id), state => state.status === 'running');
  const fresh = await (await fetch(originalChatUrl, { headers })).json();
  assert.notEqual(fresh.controlVersion, stale.controlVersion);
  const cancel = (version: string) => fetch(originalChatUrl + '/control', { method: 'POST', headers, body: JSON.stringify({ action: 'cancel', version }) });
  assert.equal((await cancel(stale.controlVersion)).status, 409);
  assert.equal((await cancel(fresh.controlVersion)).status, 200);
});

test('a thread account grants replies, verified downloads, and task control independently across pairings', async t => {
  const fixture = await scriptedFixture(context => {
    if (!hasTool(context, 'task_submit')) return fauxAssistantMessage(fauxToolCall('task_prepare', {
      outcome: 'Prepare evidence', deliverables: ['Evidence'], inputs: [], scope: ['Local test workspace'], assumptions: [], questions: [],
      criteria: [{ text: 'Verify the original evidence', method: 'inspect' }],
      budget: { maxEstimatedCostUsd: 1, maxDurationMs: 60_000, maxTotalTokens: 64_000 },
    }), { stopReason: 'toolUse' });
    if (!context.messages.some(message => message.role === 'user' && message.content === 'Use the original evidence')) {
      return fauxAssistantMessage(fauxToolCall('ask_user', { question: 'Which evidence?', options: ['Use the original evidence', 'Stop'] }), { stopReason: 'toolUse' });
    }
    return fauxAssistantMessage(fauxToolCall('task_submit', { summary: 'Original evidence verified.', artifacts: ['evidence.txt'],
      criteria: [{ id: 1, status: 'passed', evidence: 'The original evidence is present in the selected workspace.' }],
    }), { stopReason: 'toolUse' });
  });
  await writeFile(join(fixture.workspace, 'evidence.txt'), 'Verified account evidence.');
  await fixture.runtime.close();
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>(resolve => listener.close(() => resolve()));
  const config = { ...fixture.settings, port };
  let host = await serve(config, { models: fixture.models });
  t.after(async () => { await host.close(); await fixture.close(); });
  const client = createClient(config);
  const task = await host.runtime.create('Verify the account evidence.', fixture.workspace, [], { prepare: true });
  await until(() => host.runtime.status(task.id), value => value.status === 'awaiting_confirmation');
  const ownerPath = '/v1/tasks/' + task.id;
  const grantPath = ownerPath + '/accounts/research';
  const pair = (accountId: string, deviceId: string) => client.request<{ token: string }>('/v1/remote/devices', 'POST', { accountId, deviceId });
  const first = await pair('research', 'first'), outsider = await pair('outside', 'first');
  const origin = 'http://127.0.0.1:' + port;
  const path = '/remote/api/shared-threads/' + task.id;
  const remote = (token: string, url = path, body?: unknown) => fetch(origin + url, {
    method: body === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const configPath = join(fixture.directory, 'thread-accounts-config.json');
  await writeFile(configPath, JSON.stringify(config));
  const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'remote', 'grant-thread-account',
    task.id, 'research', 'viewer', '--config', configPath]);
  assert.equal(JSON.parse(stdout).role, 'viewer');
  assert.equal((await remote(outsider.token)).status, 404);
  const readOnly = await (await remote(first.token)).json();
  assert.equal(readOnly.brief, null);
  assert.equal((await remote(first.token, path + '/confirm', { revision: 1, digest: '0'.repeat(64) })).status, 403);
  await client.request(grantPath, 'PUT', { role: 'participant', controls: true });
  await host.close();
  host = await serve(config, { models: fixture.models });
  const later = await pair('research', 'later');
  const ready = await (await remote(later.token)).json();
  assert.equal(ready.id, task.id);
  assert.equal((await remote(later.token, path + '/confirm', { revision: ready.brief.revision, digest: ready.briefDigest })).status, 200);
  const waiting = await until(() => host.runtime.status(task.id), value => value.status === 'waiting_user' && value.submission?.status === 'done');
  assert(waiting.budget.totalTokens < waiting.goal!.tokenLimit!, JSON.stringify(waiting.budget));
  const answered = await remote(later.token, path + '/answers', { questionId: waiting.userQuestion!.id, requestId: 'account-answer',
    answer: 'Use the original evidence' });
  assert.equal(answered.status, 200, await answered.text());
  const completed = await until(() => host.runtime.status(task.id), value => value.status === 'completed');
  assert.equal(completed.goal?.tokenLimit, waiting.goal?.tokenLimit);
  assert.deepEqual((await (await remote(first.token)).json()).artifacts, []);
  await client.request(grantPath, 'PUT', { role: 'viewer', files: true });
  const readyFiles = await (await remote(first.token)).json();
  const artifact = readyFiles.artifacts[0]!;
  assert.equal(await (await remote(later.token, artifact.href)).text(), 'Verified account evidence.');
  assert.equal((await remote(first.token, path + '/control', { action: 'cancel', version: '0'.repeat(64) })).status, 403);
  await client.request(grantPath, 'PUT', { role: 'viewer' });
  assert.equal((await remote(later.token, artifact.href)).status, 403);
  await client.request(ownerPath + '/share-thread', 'POST', { accountId: 'research', deviceId: 'first' });
  await client.request(grantPath, 'DELETE');
  assert.equal((await remote(later.token)).status, 404);
  assert.equal(await (await remote(first.token, artifact.href)).text(), 'Verified account evidence.');
});
