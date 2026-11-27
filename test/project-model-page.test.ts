import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import test from 'node:test';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { createClient } from '../src/client.js';
import { serve } from '../src/server.js';
import { scriptedFixture } from './helpers.js';

test('the local model page checks, sets and clears only the project attached to its ticket', async t => {
  const fixture = await scriptedFixture(() => fauxAssistantMessage('Ready.'));
  await fixture.runtime.close();
  const alternate = fauxProvider({ provider: 'another-local', models: [{ id: 'project-model' }] });
  alternate.setResponses([fauxAssistantMessage('OK')]);
  fixture.models.setProvider(alternate.provider);
  const socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const settings = { ...fixture.settings, port };
  const server = await serve(settings, { models: fixture.models });
  t.after(async () => { await server.close(); await fixture.close(); });
  const foreign = join(fixture.directory, 'foreign-project');
  await mkdir(foreign);
  const existing = await server.runtime.create('Existing chat configuration.', fixture.workspace, [], { chat: true });
  const client = createClient(settings);
  const result = await client.request<{ url: string }>('/v1/settings/models/link', 'POST', { workspace: fixture.workspace });
  const page = await fetch(result.url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /项目模型/);
  const base = new URL(result.url);
  const ticket = base.hash.slice(1);
  const call = (action: string, method: string, token?: string, input?: unknown) => fetch(base.origin + base.pathname + '/' + action, {
    method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(input ? { 'Content-Type': 'application/json' } : {}) },
    ...(input ? { body: JSON.stringify(input) } : {}),
  });
  assert.equal((await call('state', 'GET')).status, 401);
  const crossed = await fetch(base.origin + '/workboard/session', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket }) });
  assert.equal(crossed.status, 401);
  const { token } = await (await call('session', 'POST', undefined, { ticket })).json();
  assert.equal((await call('session', 'POST', undefined, { ticket })).status, 401);
  const before = await (await call('state', 'GET', token)).json();
  assert.equal(before.override, null);
  const model = { provider: 'another-local', modelId: 'project-model' };
  assert.equal((await call('model', 'POST', token, { ...model, workspace: foreign })).status, 400);
  assert.equal((await (await call('check', 'POST', token, model)).json()).status, 'available');
  assert.equal((await call('model', 'POST', token, model)).status, 200);
  const saved = await (await call('state', 'GET', token)).json();
  assert.deepEqual(saved.override, model);
  assert.deepEqual(await server.runtime.providers.selected(fixture.settings.model, foreign), fixture.settings.model);
  assert.deepEqual((await server.runtime.metadata(existing.id)).model, fixture.settings.model);
  assert.deepEqual((await server.runtime.create('New chat configuration.', fixture.workspace, [], { chat: true })).model, model);
  assert.equal((await call('model', 'DELETE', token)).status, 200);
  assert.equal((await (await call('state', 'GET', token)).json()).override, null);
});
