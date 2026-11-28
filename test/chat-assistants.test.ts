import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxToolCall, Type, type ToolResultMessage } from '@earendil-works/pi-ai';
import { defineExtension, defineTool } from '@earendil-works/pi-durable';
import { LocalRuntime } from '../src/runtime.js';
import { hasTool, scriptedFixture, until } from './helpers.js';

const call = (name: string, args: Record<string, unknown>) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' });
const value = (result: ToolResultMessage) => JSON.parse(result.content.filter(part => part.type === 'text').map(part => part.text).join(''));

test('ordinary chat configures existing browser defaults from safe metadata without opening a browser or task', async t => {
  const browser = { forTask() { assert.fail('Saving a browser default must not start it.'); }, release() {} };
  const f = await scriptedFixture(context => {
    const results = context.messages.filter((message): message is ToolResultMessage => message.role === 'toolResult');
    for (const result of results) assert.equal(result.isError, false, JSON.stringify(result));
    const catalog = results.find(result => result.toolName === 'assistant_catalog');
    if (!catalog) return call('assistant_catalog', { kind: 'browsers', query: 'alpha' });
    assert.deepEqual(value(catalog).items, [{ name: 'alpha', connected: false }]);
    assert.doesNotMatch(JSON.stringify(value(catalog)), /browserSession|lease|command|environment/);
    const created = results.find(result => result.toolName === 'assistant_create');
    if (!created) return call('assistant_create', { name: 'Browser reader', instructions: 'Use the selected browser for requested work.', tools: ['read'], browserProfile: 'alpha' });
    const role = value(created).assistant;
    assert.equal(role.browserProfile, 'alpha');
    const updates = results.filter(result => result.toolName === 'assistant_update');
    if (!updates.length) return call('assistant_update', { id: role.id, revision: 1, browserProfile: 'beta' });
    assert.equal(value(updates[0]!).assistant.browserProfile, 'beta');
    if (updates.length === 1) return call('assistant_update', { id: role.id, revision: 2, browserProfile: null });
    assert.equal(value(updates[1]!).assistant.browserProfile, undefined);
    return fauxAssistantMessage('Saved the settings without starting work.');
  }, {}, () => [], { browserProfiles: new Map([['alpha', browser], ['beta', browser]]) });
  t.after(() => f.close());
  const chat = await f.runtime.create('Configure browser defaults only.', f.workspace, [], { chat: true });
  const done = await until(() => f.runtime.status(chat.id), row => ['answered', 'failed'].includes(row.status));
  assert.equal(done.status, 'answered');
  assert.equal(done.goal, undefined);
  assert.equal(done.assistant, undefined);
  assert.equal((await f.runtime.list()).length, 1);
  const [role] = await f.runtime.assistants.list(f.workspace);
  assert.equal(role.revision, 3);
  assert.equal(role.browserProfile, undefined);
});

test('ordinary chat assigns exact catalogue Skill versions and can clear or restore the defaults without starting work', async t => {
  let selected: { name: string; version: string }[] = [];
  const f = await scriptedFixture(context => {
    const results = context.messages.filter((message): message is ToolResultMessage => message.role === 'toolResult');
    for (const result of results) assert.equal(result.isError, false, JSON.stringify(result));
    const catalog = results.find(result => result.toolName === 'assistant_catalog');
    if (!catalog) return call('assistant_catalog', { kind: 'skills', query: 'chat-assigned-proof' });
    const [method] = value(catalog).items;
    assert.equal(method.name, 'chat-assigned-proof');
    assert.match(method.currentVersion, /^[a-f0-9]{64}$/);
    selected = [{ name: method.name, version: method.currentVersion }];
    const created = results.find(result => result.toolName === 'assistant_create');
    if (!created) return call('assistant_create', { name: 'Method reader', instructions: 'Read assigned originals.', tools: ['read'], skills: selected });
    const saved = value(created).assistant;
    assert.deepEqual(saved.skills, selected);
    const edits = results.filter(result => result.toolName === 'assistant_update');
    if (!edits.length) return call('assistant_update', { id: saved.id, revision: 1, skills: [] });
    assert.deepEqual(value(edits[0]!).assistant.skills, []);
    if (edits.length === 1) return call('assistant_update', { id: saved.id, revision: 2, skills: null });
    assert.equal(value(edits[1]!).assistant.skills, undefined);
    return fauxAssistantMessage('Assignment saved and defaults restored.');
  });
  t.after(() => f.close());
  const source = join(f.workspace, '.kada', 'skills', 'chat-assigned-proof');
  await mkdir(source, { recursive: true });
  await writeFile(join(source, 'SKILL.md'), '---\nname: chat-assigned-proof\ndescription: Apply the original method.\n---\n\nRead the original.\n');
  const chat = await f.runtime.create('Configure and restore this reader, without starting its work.', f.workspace, [], { chat: true });
  const done = await until(() => f.runtime.status(chat.id), row => ['answered', 'failed'].includes(row.status));
  assert.equal(done.status, 'answered');
  assert.equal(done.goal, undefined);
  assert.equal(done.assistant, undefined);
  const [role] = await f.runtime.assistants.list(f.workspace);
  assert.equal(role.revision, 3);
  assert.equal(role.skills, undefined);
  assert.equal((await f.runtime.list()).length, 1);
});

test('ordinary chat manages one assistant across restart without a Goal or starting the configured role', async t => {
  let phase = 'create', id = '';
  const f = await scriptedFixture(context => {
    const results = context.messages.filter((message): message is ToolResultMessage => message.role === 'toolResult');
    for (const result of results) assert.equal(result.isError, false);
    assert(hasTool(context, 'assistant_create')); assert(!hasTool(context, 'write'));
    if (phase === 'create' && !results.some(result => result.toolName === 'assistant_create')) return call('assistant_create', {
      name: 'Reader', instructions: 'Read the original documents.', tools: ['read'],
    });
    if (phase === 'edit' && !results.some(result => result.toolName === 'assistant_read')) return call('assistant_read', { id });
    const edits = results.filter(result => result.toolName === 'assistant_update');
    if (phase === 'edit' && !edits.length) return call('assistant_update', { id, revision: 1, instructions: 'Read originals and cite evidence.', description: 'A reusable reader' });
    if (phase === 'archive' && edits.length === 1) return call('assistant_update', { id, revision: 2, archived: true });
    if (phase === 'archive' && !results.some(result => result.toolName === 'assistants_list')) return call('assistants_list', { includeArchived: true });
    return fauxAssistantMessage('Configuration saved; no work started.');
  });
  let runtime = f.runtime;
  t.after(async () => { await runtime.close(); await f.close(); });
  const chat = await runtime.create('Save a reader configuration only.', f.workspace, [], { chat: true });
  const created = await until(() => runtime.status(chat.id), row => ['answered', 'failed'].includes(row.status));
  assert.equal(created.status, 'answered'); assert.equal(created.goal, undefined); assert.equal(created.assistant, undefined);
  const [role] = await runtime.assistants.list(f.workspace); id = role.id;
  await runtime.close(); runtime = new LocalRuntime(f.settings, { models: f.models }); await runtime.recover();
  phase = 'edit'; await runtime.followUp(chat.id, 'Update the saved reader instructions and description.', 'reader-edit');
  const edited = await until(() => runtime.status(chat.id), row => row.status === 'answered' && row.submission?.requestId === 'user:reader-edit');
  assert.equal(edited.goal, undefined); assert.equal((await runtime.assistants.get(id)).instructions, 'Read originals and cite evidence.');
  phase = 'archive'; await runtime.followUp(chat.id, 'Archive the saved role, preserving its history.', 'reader-archive');
  const archived = await until(() => runtime.status(chat.id), row => row.status === 'answered' && row.submission?.requestId === 'user:reader-archive');
  assert.equal(archived.goal, undefined); assert.equal((await runtime.assistants.get(id)).archived, true);
  assert.equal((await runtime.list()).length, 1); assert.equal(archived.assistant, undefined);
  assert.doesNotMatch(JSON.stringify(archived.messages.filter(message => message.role === 'toolResult')), /fingerprint|operations/);
});

test('chat role management rejects foreign definitions and model-chosen project scope before writing', async t => {
  let id = '', step = 0;
  const f = await scriptedFixture(context => {
    const results = context.messages.filter((message): message is ToolResultMessage => message.role === 'toolResult');
    for (const result of results) assert.equal(result.isError, true);
    const operations = [
      () => call('assistant_read', { id }), () => call('assistant_update', { id, revision: 1, instructions: 'Injected' }),
      () => call('assistant_create', { name: 'Injected', instructions: 'Injected', tools: ['read'], workspace: 'elsewhere' }),
    ];
    return step < operations.length ? operations[step++]!() : fauxAssistantMessage('Rejected.');
  });
  t.after(() => f.close()); const other = join(f.directory, 'foreign'); await mkdir(other);
  const role = await f.runtime.assistants.create({ workspace: other, name: 'PRIVATE_ROLE_672', instructions: 'PRIVATE_INSTRUCTIONS_193', tools: ['read'] }); id = role.id;
  const chat = await f.runtime.create('Check scope rejection.', f.workspace, [], { chat: true });
  const done = await until(() => f.runtime.status(chat.id), row => ['answered', 'failed'].includes(row.status));
  assert.equal(done.status, 'answered'); assert.equal(step, 3); assert.equal((await f.runtime.assistants.get(id)).revision, 1);
  assert.deepEqual(await f.runtime.assistants.list(f.workspace), []);
  assert.doesNotMatch(JSON.stringify(done.messages.filter(message => message.role === 'toolResult')), /PRIVATE_ROLE_672|PRIVATE_INSTRUCTIONS_193/);
});

test('assistant_read returns a complete maximum-size instruction string without native output truncation', async t => {
  let id = '';
  const instructions = '原'.repeat(15998) + '尾端';
  const f = await scriptedFixture(context => {
    const result = context.messages.find((message): message is ToolResultMessage => message.role === 'toolResult' && message.toolName === 'assistant_read');
    if (!result) return call('assistant_read', { id });
    assert.equal(result.isError, false); assert.equal(value(result).instructions, instructions);
    return fauxAssistantMessage('Full instructions read.');
  });
  t.after(() => f.close());
  id = (await f.runtime.assistants.create({ workspace: f.workspace, name: 'Long reader', instructions, tools: ['read'] })).id;
  const chat = await f.runtime.create('Read full settings.', f.workspace, [], { chat: true });
  const done = await until(() => f.runtime.status(chat.id), row => ['answered', 'failed'].includes(row.status));
  assert.equal(done.status, 'answered'); assert.equal(done.goal, undefined);
});

test('assistant metadata catalogs page original execution tools and installed models without enabling or invoking them', async t => {
  let step = 0;
  const f = await scriptedFixture(context => {
    assert(!hasTool(context, 'write')); assert(!hasTool(context, 'catalog_probe_0'));
    const operations = [
      () => call('assistant_catalog', { kind: 'tools', query: 'catalog_probe_', limit: 1 }),
      () => call('assistant_catalog', { kind: 'tools', query: 'catalog_probe_', limit: 1, offset: 1 }),
      () => call('assistant_catalog', { kind: 'models', query: f.settings.model!.modelId }),
      () => call('assistant_catalog', { kind: 'tools', query: 'definitely_absent_792' }),
    ];
    return step < operations.length ? operations[step++]!() : fauxAssistantMessage('Metadata read; no tools enabled.');
  }, {}, () => [defineExtension({ name: 'catalog_probe_tools', tools: Array.from({ length: 3 }, (_, i) => defineTool({
    name: 'catalog_probe_' + i, description: 'Original execution metadata', parameters: Type.Object({}), execute: async () => { assert.fail('Catalog metadata must not invoke a tool.'); },
  })) })]);
  t.after(() => f.close());
  const chat = await f.runtime.create('Read available configuration identifiers.', f.workspace, [], { chat: true });
  const done = await until(() => f.runtime.status(chat.id), row => ['answered', 'failed'].includes(row.status));
  assert.equal(done.status, 'answered'); assert.equal(done.goal, undefined);
  const results = done.messages.filter((message): message is ToolResultMessage => message.role === 'toolResult').map(value);
  assert.equal(results[0].total, 3); assert.equal(results[0].nextOffset, 1); assert.equal(results[1].nextOffset, 2);
  assert.notEqual(results[0].items[0].name, results[1].items[0].name);
  assert(results[2].items.some((model: { provider: string; modelId: string }) => model.provider === f.settings.model!.provider && model.modelId === f.settings.model!.modelId));
  assert.deepEqual(results[2].currentModel, f.settings.model); assert.deepEqual(results[2].defaultModel, f.settings.model);
  assert.equal(results[3].total, 0);
});

test('historical, remote, preparation, execution and restricted-role chats do not acquire management authority', async t => {
  const names = ['assistants_list', 'assistant_read', 'assistant_catalog', 'assistant_create', 'assistant_update'];
  const f = await scriptedFixture(context => {
    const last = context.messages.filter(message => message.role === 'user').at(-1)?.content;
    for (const name of names) assert.equal(hasTool(context, name), last === 'Seed new chat');
    if (hasTool(context, 'task_submit')) return call('task_submit', { summary: 'Done.', artifacts: [] });
    if (last === 'Prepare') return call('task_prepare', { outcome: 'Inspect', deliverables: ['Notes'], inputs: [], scope: ['Read'], assumptions: [], questions: [], criteria: [{ text: 'Inspected', method: 'inspect' }] });
    return fauxAssistantMessage('No management action.');
  });
  let runtime = f.runtime;
  t.after(async () => { await runtime.close(); await f.close(); });
  const old = await runtime.create('Seed new chat', f.workspace, [], { chat: true });
  await until(() => runtime.status(old.id), row => row.status === 'answered');
  const meta = await runtime.metadata(old.id); delete meta.chatAssistants;
  await runtime.close(); await writeFile(join(f.directory, 'tasks', old.id, 'task.json'), JSON.stringify(meta));
  runtime = new LocalRuntime(f.settings, { models: f.models }); await runtime.recover();
  await runtime.followUp(old.id, 'Historical follow-up', 'old-chat');
  await until(() => runtime.status(old.id), row => row.status === 'answered' && row.submission?.requestId === 'user:old-chat');
  const remote = await runtime.create('Remote', f.workspace, [], { chat: true, remote: true });
  await until(() => runtime.status(remote.id), row => row.status === 'answered');
  const prepare = await runtime.create('Prepare', f.workspace, [], { prepare: true });
  await until(() => runtime.status(prepare.id), row => row.status === 'awaiting_confirmation');
  const run = await runtime.create('Execute', f.workspace);
  await until(() => runtime.status(run.id), row => row.status === 'completed');
  const role = await runtime.assistants.create({ workspace: f.workspace, name: 'Reader', instructions: 'Read only.', tools: ['read'] });
  const restricted = await runtime.create('Restricted role', f.workspace, [], { chat: true, assistant: { id: role.id, revision: 1 } });
  await until(() => runtime.status(restricted.id), row => row.status === 'answered');
});

test('turning a configuration-capable chat into a confirmed Goal removes management from the parent and its child', async t => {
  const names = ['assistants_list', 'assistant_read', 'assistant_catalog', 'assistant_create', 'assistant_update'];
  const f = await scriptedFixture(context => {
    if (hasTool(context, 'task_prepare')) {
      for (const name of names) assert(hasTool(context, name));
      return call('task_prepare', { outcome: 'Inspect evidence', deliverables: ['A summary'], inputs: [], scope: ['Inspect project'], assumptions: [], questions: [], criteria: [{ text: 'Original evidence inspected', method: 'inspect' }] });
    }
    for (const name of names) assert(!hasTool(context, name));
    if (!hasTool(context, 'delegate')) return fauxAssistantMessage('Independent evidence inspected.');
    if (!context.messages.some(message => message.role === 'toolResult' && message.toolName === 'delegate')) return call('delegate', { tasks: [{ name: 'reader', instructions: 'Inspect independent evidence.' }] });
    return call('task_submit', { summary: 'Independent evidence inspected.', artifacts: [], criteria: [{ id: 1, status: 'passed', evidence: 'Read the child result.' }] });
  });
  t.after(() => f.close());
  const task = await f.runtime.create('Inspect the project, without changing any role definitions.', f.workspace, [], { chat: true });
  const waiting = await until(() => f.runtime.status(task.id), row => row.status === 'awaiting_confirmation');
  await f.runtime.confirm(task.id, waiting.goal!.brief!.revision, waiting.briefDigest!);
  await until(() => f.runtime.status(task.id), row => row.status === 'completed');
  assert.deepEqual(await f.runtime.assistants.list(f.workspace), []);
});

test('chat assistant lists page metadata, hide archived by default and keep restoration on the original identity', async t => {
  let archivedId = '', step = 0;
  const f = await scriptedFixture(() => {
    const operations = [
      () => call('assistants_list', { limit: 1 }), () => call('assistants_list', { limit: 1, offset: 1 }),
      () => call('assistants_list', { includeArchived: true }), () => call('assistant_update', { id: archivedId, revision: 2, archived: false }),
      () => call('assistant_read', { id: archivedId }),
    ];
    return step < operations.length ? operations[step++]!() : fauxAssistantMessage('Original role restored without starting it.');
  });
  t.after(() => f.close());
  for (const name of ['First', 'Second', 'Archived']) {
    const role = await f.runtime.assistants.create({ workspace: f.workspace, name, instructions: 'STORED_ROLE_INSTRUCTIONS_629', description: '资'.repeat(900), tools: ['read'] });
    if (name === 'Archived') { archivedId = role.id; await f.runtime.assistants.update(role.id, { revision: 1, archived: true }); }
  }
  const chat = await f.runtime.create('List project roles and restore the original archived role.', f.workspace, [], { chat: true });
  const done = await until(() => f.runtime.status(chat.id), row => ['answered', 'failed'].includes(row.status));
  assert.equal(done.status, 'answered'); assert.equal(done.goal, undefined);
  const results = done.messages.filter((message): message is ToolResultMessage => message.role === 'toolResult').map(value);
  assert.equal(results[0].total, 2); assert.equal(results[0].nextOffset, 1); assert.equal(results[1].nextOffset, null);
  assert.notEqual(results[0].items[0].id, results[1].items[0].id); assert.equal(results[0].items[0].description.length, 300); assert.equal(results[0].items[0].descriptionTruncated, true);
  assert.equal(results[2].total, 3); assert(!JSON.stringify(results.slice(0, 3)).includes('STORED_ROLE_INSTRUCTIONS_629'));
  assert.equal(results[3].assistant.id, archivedId); assert.equal(results[4].id, archivedId); assert.equal(results[4].revision, 3); assert.equal(results[4].archived, false);
  assert.equal((await f.runtime.list()).length, 1);
});

test('a full requested metadata page remains valid JSON with maximum multibyte role labels', async t => {
  const f = await scriptedFixture(context => {
    const result = context.messages.find((message): message is ToolResultMessage => message.role === 'toolResult' && message.toolName === 'assistants_list');
    if (!result) return call('assistants_list', { limit: 50 });
    assert.equal(result.isError, false); assert.equal(value(result).items.length, 50); assert.equal(value(result).nextOffset, null);
    return fauxAssistantMessage('The full page is readable.');
  });
  t.after(() => f.close());
  for (let i = 0; i < 50; i++) await f.runtime.assistants.create({ workspace: f.workspace, name: '研'.repeat(76) + String(i).padStart(2, '0'),
    instructions: 'Original instructions.', description: '资'.repeat(1000), tools: [] });
  const chat = await f.runtime.create('List one full page.', f.workspace, [], { chat: true });
  const done = await until(() => f.runtime.status(chat.id), row => ['answered', 'failed'].includes(row.status));
  assert.equal(done.status, 'answered');
});
