import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { setTimeout } from 'node:timers/promises';
import test from 'node:test';
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
