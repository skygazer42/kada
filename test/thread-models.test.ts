import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { LocalRuntime } from '../src/runtime.js';
import { hasTool, scriptedFixture, until } from './helpers.js';

const alternate = { provider: 'local-review', modelId: 'review/independent' };
const taskMessage = 'Review the independent synthetic result.';
const brief = { outcome: taskMessage, deliverables: ['Text result'], inputs: [],
  criteria: [{ text: 'Return the total', method: 'inspect' }], scope: ['Synthetic task'], assumptions: [], questions: [] };
const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' });

test('an independent second opinion uses the selected model, source role and original return model across restart', async t => {
  let returned = 0, prepared = 0, executed = 0;
  const f = await scriptedFixture(context => {
    const input = context.messages.findLast(message => message.role === 'user')?.content;
    if (typeof input === 'string' && input.includes('INDEPENDENT_THREAD_REPORT')) {
      assert(input.includes(alternate.modelId));
      returned++;
    }
    assert.notEqual(input, taskMessage);
    return fauxAssistantMessage('Source model reply.');
  });
  let runtime = f.runtime;
  t.after(async () => { await runtime.close(); await f.close(); });
  const other = fauxProvider({ provider: alternate.provider, models: [{ id: alternate.modelId }] });
  other.setResponses(Array.from({ length: 8 }, () => context => {
    assert(JSON.stringify(context.messages).includes('PINNED_ORIGINAL_ROLE'));
    assert(!hasTool(context, 'bash') && !hasTool(context, 'write'));
    if (hasTool(context, 'task_submit')) {
      executed++;
      return call('task_submit', { summary: 'Independent result: total 42.', artifacts: [], criteria: [{ id: 1, status: 'passed', evidence: 'The total is 42.' }] });
    }
    prepared++;
    return call('task_prepare', brief);
  }));
  f.models.setProvider(other.provider);
  const skill = join(f.workspace, '.kada', 'skills', 'thread-proof');
  const method = (text: string) => '---\nname: thread-proof\ndescription: Read the original second-opinion method.\n---\n\n' + text + '\n';
  await mkdir(skill, { recursive: true });
  await writeFile(join(skill, 'SKILL.md'), method('ORIGINAL_THREAD_METHOD_81'));
  const role = await runtime.assistants.create({ workspace: f.workspace, name: 'Project reader', instructions: 'PINNED_ORIGINAL_ROLE', tools: ['read'] });
  const source = await runtime.create('Discuss the project.', f.workspace, [], { chat: true, assistant: { id: role.id, revision: role.revision } });
  await until(() => runtime.status(source.id), state => state.status === 'answered');
  await writeFile(join(skill, 'SKILL.md'), method('CHANGED_THREAD_METHOD_47'));
  await runtime.assistants.update(role.id, { revision: 1, instructions: 'Changed project role.', archived: true });
  const request = { title: 'Second opinion', message: taskMessage, requestId: 'two-models', reportBack: true, modelSelection: alternate };
  const opened = await runtime.startThread(source.id, request);
  const pending = await until(() => runtime.status(opened.id), state => state.status === 'awaiting_confirmation');
  assert.deepEqual(pending.model, alternate);
  assert.deepEqual(pending.assistant, { ...source.assistant, model: alternate });
  assert.match(await readFile(pending.skillPins!.pins.find(pin => pin.name === 'thread-proof')!.filePath, 'utf8'), /ORIGINAL_THREAD_METHOD_81/);
  assert.deepEqual(await runtime.providers.selected(f.settings.model, f.workspace), f.settings.model);
  assert.equal(prepared, 1);
  assert.equal(executed, 0);
  assert.equal(returned, 0);
  await assert.rejects(runtime.startThread(source.id, { ...request, modelSelection: source.model }), /different request/i);
  await runtime.close();
  runtime = new LocalRuntime(f.settings, { models: f.models });
  await runtime.recover();
  assert.equal((await runtime.startThread(source.id, request)).id, opened.id);
  await runtime.confirm(opened.id, pending.goal!.brief!.revision, pending.briefDigest!);
  const result = await until(() => runtime.status(source.id), state => state.threadReports.length === 1 && state.status === 'answered');
  assert.deepEqual(result.model, source.model);
  assert.deepEqual(result.threadReports[0]?.model, alternate);
  assert.equal(result.threadReports[0]?.taskId, opened.id);
  assert.equal((await runtime.status(opened.id)).status, 'completed');
  assert.equal(prepared, 1);
  assert.equal(executed, 1);
  assert.equal(returned, 1);
});

test('chat offers available models and does not run a selected task on another provider after sign-out', async t => {
  let sourceCalls = 0, childCalls = 0;
  const f = await scriptedFixture(context => {
    sourceCalls++;
    const results = context.messages.filter(message => message.role === 'toolResult');
    const catalog = results.find(message => message.toolName === 'list_models');
    if (!catalog) return call('list_models', { search: 'REVIEW' });
    assert(!catalog.isError);
    const payload = JSON.parse(catalog.content.map(block => block.type === 'text' ? block.text : '').join(''));
    assert.deepEqual(payload.current, f.settings.model);
    assert.deepEqual(payload.items.map(({ provider, modelId }: typeof alternate) => ({ provider, modelId })), [alternate]);
    if (!results.some(message => message.toolName === 'start_thread')) {
      const { provider, modelId } = payload.items[0];
      return call('start_thread', { title: 'Requested model', message: taskMessage, model_selection: { provider, modelId } });
    }
    return fauxAssistantMessage('Opened on the requested model.');
  });
  t.after(() => f.close());
  const other = fauxProvider({ provider: alternate.provider, models: [{ id: alternate.modelId }] });
  other.setResponses(Array.from({ length: 6 }, () => () => { childCalls++; return call('task_prepare', brief); }));
  f.models.setProvider(other.provider);
  const offline = fauxProvider({ provider: 'offline-review', models: [{ id: 'review/signed-out' }] });
  const signedOut = { apiKey: { name: 'Signed-out fixture', resolve: async () => undefined } };
  f.models.setProvider({ ...offline.provider, auth: signedOut });
  const source = await f.runtime.create('Use the requested review model in a new thread.', f.workspace, [], { chat: true });
  const answered = await until(() => f.runtime.status(source.id), state => state.status === 'answered');
  const result = answered.messages.find(message => message.role === 'toolResult' && message.toolName === 'start_thread');
  assert(result?.role === 'toolResult' && !result.isError);
  const { id, model } = JSON.parse(result.content.map(block => block.type === 'text' ? block.text : '').join(''));
  assert.deepEqual(model, alternate);
  const pending = await until(() => f.runtime.status(id), state => state.status === 'awaiting_confirmation');
  const request = { title: 'Unavailable model', message: taskMessage, requestId: 'unavailable' };
  await assert.rejects(f.runtime.startThread(source.id, { ...request, modelSelection: { provider: 'offline-review', modelId: 'review/signed-out' } }), /unavailable/i);
  await assert.rejects(f.runtime.startThread(source.id, { ...request, modelSelection: { provider: alternate.provider, modelId: 'unknown' } }), /unknown/i);
  assert.equal((await f.runtime.list()).length, 2);
  assert.equal(sourceCalls, 3);
  assert.equal(childCalls, 1);
  f.models.setProvider({ ...other.provider, auth: signedOut });
  await f.runtime.confirm(id, pending.goal!.brief!.revision, pending.briefDigest!);
  const failed = await until(() => f.runtime.status(id), state => state.status === 'failed');
  assert.deepEqual(failed.model, alternate);
  assert.equal(sourceCalls, 3);
  assert.equal(childCalls, 1);
});
