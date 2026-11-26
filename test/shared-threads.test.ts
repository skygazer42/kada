import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import test from 'node:test';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { createClient } from '../src/client.js';
import { serve } from '../src/server.js';
import { hasTool, scriptedFixture, until } from './helpers.js';

const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' });

test('shared threads keep their original history and pending input under the selected device grant', async t => {
  let targetId: string;
  const fixture = await scriptedFixture(context => {
    const input = context.messages.findLast(message => message.role === 'user')?.content;
    if (input === 'Deliver the test file.' && hasTool(context, 'task_submit')) {
      return call('task_submit', { summary: 'Verified sample file.', artifacts: ['shared-sample.txt'] });
    }
    if (typeof input === 'string' && input.includes('Select the original dataset.')) {
      if (!context.messages.some(message => message.role === 'toolResult' && message.toolName === 'ask_user')) {
        return call('ask_user', { question: 'Which original dataset?', options: ['First', 'Second'] });
      }
    }
    if (input === 'Share the test note.' && !context.messages.some(message => message.role === 'toolResult' && message.toolName === 'post_to_thread')) {
      return call('post_to_thread', { thread_id: targetId, message: 'ORIGINAL_SHARED_NOTE_764' });
    }
    return fauxAssistantMessage('Original task state reached.');
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
  const owner = { accountId: 'owner', deviceId: 'mobile' };
  const pair = (deviceId: string) => client.request<{ token: string }>('/v1/remote/devices', 'POST', { ...owner, deviceId });
  const permitted = await pair('mobile'), other = await pair('other');
  const remote = (path: string, token = permitted.token, body?: unknown) => fetch(`http://127.0.0.1:${port}/remote/api/shared-threads${path}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const role = await server.runtime.assistants.create({ workspace: fixture.workspace, name: 'Thread reader', instructions: 'Handle the owner’s test inputs.', tools: ['post_to_thread'] });
  const assistant = { id: role.id, revision: role.revision };
  const target = await server.runtime.create('Select the original dataset.', fixture.workspace, [], { chat: true, assistant });
  targetId = target.id;
  const noteSource = await server.runtime.create('Share the test note.', fixture.workspace, [], { chat: true, assistant });
  const waiting = await until(() => server.runtime.status(targetId), state => state.status === 'waiting_user');
  await until(() => server.runtime.status(noteSource.id), state => state.status === 'answered');
  const question = waiting.userQuestion!;
  const share = (taskId: string, action: string) => client.request(`/v1/tasks/${taskId}/${action}`, 'POST', owner);
  assert.equal((await remote('/' + targetId)).status, 404);
  await assert.rejects(share(targetId, 'share-thread-replies'), /share.*view/i);
  await share(targetId, 'share-thread');
  assert.equal((await remote('/' + targetId, other.token)).status, 404);
  assert.deepEqual((await (await remote('')).json()).map((row: { id: string }) => row.id), [targetId]);
  const detail = await (await remote('/' + targetId)).json();
  assert.equal(detail.id, targetId);
  assert(detail.messages.some((message: { text: string }) => message.text.includes('Select the original dataset.')));
  assert.equal(detail.notes[0].message, 'ORIGINAL_SHARED_NOTE_764');
  assert(!detail.notes[0].sourceTaskId);
  assert.equal(detail.question.id, question.id);
  assert.equal(detail.canReply, false);
  const reply = { questionId: question.id, requestId: 'original-answer', answer: 'Second' };
  assert.equal((await remote('/' + targetId + '/answers', permitted.token, reply)).status, 403);
  await share(noteSource.id, 'share-thread');
  assert.equal((await (await remote('/' + targetId)).json()).notes[0].sourceTaskId, noteSource.id);
  await share(targetId, 'share-thread-replies');
  assert.equal((await remote('/' + targetId + '/answers', permitted.token, reply)).status, 200);
  await until(() => server.runtime.status(targetId), state => state.status === 'answered');
  const original = await server.runtime.status(targetId);
  await server.close();
  server = await serve(settings, { models: fixture.models });
  assert.equal((await remote('/' + targetId + '/answers', permitted.token, reply)).status, 200);
  assert.equal((await remote('/' + targetId + '/answers', permitted.token, { ...reply, answer: 'First' })).status, 409);
  assert.equal((await server.runtime.status(targetId)).submission?.id, original.submission?.id);
  for (let index = 1; index <= 17; index++) {
    await server.runtime.followUp(targetId, 'History sample ' + index, 'history-' + index);
    await until(() => server.runtime.status(targetId), state => state.status === 'answered' && state.submission?.requestId === 'user:history-' + index);
  }
  const page = await (await remote('/' + targetId)).json();
  assert.equal(page.messages.length, 30);
  assert.equal(page.before, page.messages[0].sequence);
  const earlier = await (await remote('/' + targetId + '?before=' + page.before)).json();
  assert(earlier.messages.some((message: { text: string }) => message.text.includes('Select the original dataset.')));
  assert(earlier.messages.every((message: { sequence: number }) => message.sequence < page.before));
  assert.equal((await remote('/' + targetId + '?before=broken')).status, 400);
  const path = join(fixture.workspace, 'shared-sample.txt');
  await writeFile(path, 'Original verified bytes');
  const delivery = await server.runtime.create('Deliver the test file.', fixture.workspace);
  await until(() => server.runtime.status(delivery.id), state => state.status === 'completed');
  await share(delivery.id, 'share-thread');
  const artifact = (await (await remote('/' + delivery.id)).json()).artifacts[0];
  const artifactPath = artifact.href.replace('/remote/api/shared-threads', '');
  assert.equal(await (await remote(artifactPath)).text(), 'Original verified bytes');
  assert.equal((await remote(artifactPath, other.token)).status, 404);
  await writeFile(path, 'Changed bytes');
  assert.equal((await remote(artifactPath)).status, 409);
  await share(targetId, 'unshare-thread');
  assert.equal((await remote('/' + targetId)).status, 404);
  await share(targetId, 'share-thread');
  assert.equal((await (await remote('/' + targetId)).json()).canReply, false);
  await client.request('/v1/remote/devices/owner/mobile', 'DELETE');
  assert.equal((await remote('/' + targetId)).status, 401);
  const repaired = await pair('mobile');
  assert.deepEqual(await (await remote('', repaired.token)).json(), []);
});
