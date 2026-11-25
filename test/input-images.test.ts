import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { imageInput, type InputImage } from '../src/input-images.js';
import { LocalRuntime } from '../src/runtime.js';
import { Harness, createRegistry } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { GoalDoc } from '../src/goal.js';
import { pngFixture, scriptedFixture, until } from './helpers.js';

test('image preparation observes model count, resizing and original checksum', async () => {
  const f = await scriptedFixture(() => fauxAssistantMessage('unused'));
  try {
    const bytes = pngFixture(12, 12), path = join(f.directory, 'original.png');
    await writeFile(path, bytes);
    const reference = { path, mimeType: 'image/png', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    const provider = fauxProvider({ provider: 'images', models: [
      { id: 'vision', input: ['text', 'image'], inputLimits: { images: { maxPerMessage: 1, resize: { maxWidth: 2, maxHeight: 2, maxBytes: 1024 } } } },
      { id: 'text', input: ['text'] },
    ] });
    f.models.setProvider(provider.provider);
    const content = await imageInput('Inspect attached files', [reference, reference], f.models.getModel('images', 'vision')!);
    assert.notEqual(typeof content, 'string');
    const images = typeof content === 'string' ? [] : content.filter(block => block.type === 'image');
    assert.equal(images.length, 1);
    assert(images[0].data.length <= 1024);
    assert.notEqual(images[0].data, bytes.toString('base64'));
    assert.match(JSON.stringify(content), /exceed.*image limit/i);
    assert.match(String(await imageInput('Inspect', [reference], f.models.getModel('images', 'text')!)), /does not support image input/);
    await writeFile(path, Buffer.alloc(bytes.length));
    await assert.rejects(imageInput('Inspect', [reference], f.models.getModel('images', 'vision')!), /changed/);
  } finally { await f.close(); }
});

for (const boundary of ['initial', 'goal-follow-up'] as const) test(`remote images recover from the saved ${boundary} before Pi admission`, async () => {
  const f = await scriptedFixture(() => fauxAssistantMessage('unused'));
  const vision = fauxProvider({ provider: 'local-test', models: [{ id: 'scripted', input: ['text', 'image'] }] });
  let seen = 0;
  vision.setResponses(Array.from({ length: 10 }, () => context => {
    const input = context.messages.findLast(message => message.role === 'user')!;
    const count = typeof input.content === 'string' ? 0 : input.content.filter(block => block.type === 'image').length;
    if (boundary === 'goal-follow-up' && !JSON.stringify(input.content).includes('The answer image')) {
      return fauxAssistantMessage(fauxToolCall('task_blocked', { reason: 'Need an image', question: 'Supply the answer image' }), { stopReason: 'toolUse' });
    }
    assert.equal(count, 1);
    seen++;
    return boundary === 'initial' ? fauxAssistantMessage('Image received') : fauxAssistantMessage(
      fauxToolCall('task_submit', { summary: 'Verified answer image', artifacts: [] }), { stopReason: 'toolUse' });
  }));
  f.models.setProvider(vision.provider);
  const path = join(f.directory, 'delayed-image.png'), bytes = pngFixture();
  const reference: InputImage = { path, mimeType: 'image/png', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  let recovered: LocalRuntime | undefined;
  try {
    let id: string;
    if (boundary === 'initial') {
      await assert.rejects(f.runtime.create('Inspect image', f.workspace, [], { remote: true, chat: true, images: [reference] }), /ENOENT/);
      [id] = (await f.runtime.list()).map(task => task.id);
    } else {
      const task = await f.runtime.create('Wait for answer', f.workspace, [], { remote: true });
      id = task.id;
      await until(() => f.runtime.status(id), status => status.status === 'waiting_user');
      await assert.rejects(f.runtime.followUp(id, 'The answer image', 'answer-image', [reference]), /ENOENT/);
      assert.equal((await f.runtime.status(id)).goal?.outbox?.requestId, 'user:answer-image');
    }
    await f.runtime.close();
    await writeFile(path, bytes);
    recovered = new LocalRuntime(f.settings, { models: f.models });
    await recovered.recover();
    const result = await until(() => recovered!.status(id), status => status.status === (boundary === 'initial' ? 'answered' : 'completed'));
    assert.equal(seen, 1);
    assert.equal(result.messages.filter(message => message.role === 'user').length, boundary === 'initial' ? 1 : 2);
    assert.equal(result.goal?.outbox ?? null, null);
    if (boundary === 'goal-follow-up') {
      await recovered.close();
      const harness = await Harness.open(await openNodeSqliteStorage(join(f.directory, 'tasks', id, 'session.sqlite')), {
        models: f.models, registry: createRegistry(),
      }, BACKGROUND_CONTEXT);
      await harness.commit(async tx => {
        const goal = await tx.doc(GoalDoc);
        goal.phase = 'submitted'; goal.verification = null; goal.mechanical = null; goal.lastEvaluated = null;
        goal.outbox = { requestId: 'user:answer-image', content: 'The answer image', images: [reference] };
      }, BACKGROUND_CONTEXT);
      await harness.close(BACKGROUND_CONTEXT);
      await rm(path);
      recovered = new LocalRuntime(f.settings, { models: f.models });
      await recovered.recover();
      const settled = await until(() => recovered!.status(id), status => status.status === 'completed');
      assert.equal(settled.goal?.outbox, null);
      assert.equal(seen, 1);
    }
  } finally { await recovered?.close(); await f.close(); }
});
