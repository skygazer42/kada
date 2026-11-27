import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { ChatSession } from '../src/chat.js';
import { createClient } from '../src/client.js';
import { serve } from '../src/server.js';
import { hasTool, scriptedFixture, until } from './helpers.js';

test('a private assistant retains its original memory and history across a role edit and restart', async t => {
  const fact = 'Use JuniperToken for project summaries.';
  const shared = 'Use SharedMallow for project summaries.';
  const lookups = new Map<string, string>();
  const home = await mkdtemp(join(tmpdir(), 'kada-memory-role-home-'));
  const f = await scriptedFixture(context => {
    const input = context.messages.findLast(message => message.role === 'user')?.content;
    if (input === 'Find original preference' || input === 'Second assistant') {
      const result = context.messages.find(message => message.role === 'toolResult' && message.toolName === 'user_memory_search');
      if (!result) return fauxAssistantMessage(fauxToolCall('user_memory_search', { query: 'JuniperToken', domain: 'general' }), { stopReason: 'toolUse' });
      lookups.set(input, JSON.stringify(result.content));
      return fauxAssistantMessage('Lookup complete.');
    }
    if (input !== fact) return fauxAssistantMessage('Original conversation ready.');
    assert(!JSON.stringify(context.messages).includes('SharedMallow'));
    assert(hasTool(context, 'user_remember'));
    if (context.messages.some(message => message.role === 'toolResult' && message.toolName === 'user_remember')) {
      return fauxAssistantMessage('Memory proposed.');
    }
    return fauxAssistantMessage(fauxToolCall('user_remember', { facts: [{ text: fact, category: 'preferences',
      domain: 'general', scope: 'project', certainty: 'stated', evidence: [{ sourceId: 'user', quote: fact }] }] }), { stopReason: 'toolUse' });
  }, { discovery: true }, undefined, { discovery: { home } });
  let runtime = f.runtime;
  let server: Awaited<ReturnType<typeof serve>> | undefined;
  t.after(async () => {
    if (server) await server.close();
    else await runtime.close();
    await f.close();
    await rm(home, { recursive: true, force: true });
  });
  await writeFile(join(f.workspace, '.kada-project'), '');
  await writeFile(join(f.workspace, 'AGENTS.md'), shared);
  await runtime.memoryReview(f.workspace, true);
  const make = (name: string) => runtime.assistants.create({ workspace: f.workspace, name, instructions: 'Keep the original context.',
    memoryScope: 'isolated', tools: ['user_remember', 'user_memory_search', 'history_search', 'history_read'] });
  const first = await make('Writer'), second = await make('Reviewer');
  const ref = ({ id, revision }: { id: string; revision: number }) => ({ id, revision });
  const run = await runtime.create(fact, f.workspace, [], { chat: true, assistant: ref(first) });
  await until(() => runtime.status(run.id), state => state.status === 'answered');
  const [candidate] = await runtime.memoryCandidates(f.workspace, undefined, undefined, first.id);
  assert.equal(candidate?.text, fact);
  assert.deepEqual(await runtime.memoryCandidates(f.workspace, undefined, undefined, second.id), []);
  assert(!(await runtime.localMemory(f.workspace, first.id)).facts.some(record => record.text.includes('JuniperToken')));
  await runtime.memoryCandidates(f.workspace, candidate!.id, 'accept', first.id);
  assert((await runtime.localMemory(f.workspace, first.id)).facts.some(record => record.text === fact));
  assert(!(await runtime.localMemory(f.workspace, second.id)).facts.some(record => record.text.includes('JuniperToken')));
  const normal = await runtime.localMemory(f.workspace);
  assert(normal.facts.some(record => record.text.includes('SharedMallow')));
  assert(!normal.facts.some(record => record.text.includes('JuniperToken')));
  const reader = await runtime.create('Find original preference', f.workspace, [], { chat: true, assistant: ref(first) });
  const other = await runtime.create('Second assistant', f.workspace, [], { chat: true, assistant: ref(second) });
  await until(() => runtime.status(reader.id), state => state.status === 'answered');
  await until(() => runtime.status(other.id), state => state.status === 'answered');
  assert.match(lookups.get('Find original preference') ?? '', /JuniperToken/);
  assert.doesNotMatch(lookups.get('Second assistant') ?? '', /JuniperToken/);
  const [hit] = await runtime.searchHistory(reader.id, 'JuniperToken');
  assert.equal(hit?.taskId, run.id);
  assert.deepEqual(await runtime.searchHistory(other.id, 'JuniperToken'), []);
  await assert.rejects(runtime.readHistory(other.id, run.id, hit!.entryId), /not found/i);
  assert((await runtime.projectTasks(reader.id)).tasks.some(task => task.id === run.id));
  assert(!(await runtime.projectTasks(other.id)).tasks.some(task => task.id === run.id));
  const outside = join(f.directory, 'another-project');
  await mkdir(outside);
  await assert.rejects(runtime.localMemory(outside, first.id), /not found/i);
  const edited = await runtime.assistants.update(first.id, { revision: first.revision, memoryScope: 'shared' });
  await runtime.close();
  const slot = createServer();
  await new Promise<void>(resolve => slot.listen(0, '127.0.0.1', resolve));
  const port = (slot.address() as { port: number }).port;
  await new Promise<void>(resolve => slot.close(() => resolve()));
  const config = { ...f.settings, port };
  server = await serve(config, { models: f.models, discovery: { home } });
  runtime = server.runtime;
  assert.equal((await runtime.metadata(reader.id)).assistant?.memoryScope, 'isolated');
  assert.equal((await runtime.readHistory(reader.id, run.id, hit!.entryId)).text, fact);
  const sharedTask = await runtime.create('New shared assistant', f.workspace, [], { chat: true, assistant: ref(edited) });
  assert.deepEqual(await runtime.searchHistory(sharedTask.id, 'JuniperToken'), []);
  const memoryPath = '/v1/environment/memory';
  const scope = '?' + new URLSearchParams({ workspace: f.workspace, assistant: first.id });
  assert.equal((await fetch('http://127.0.0.1:' + port + memoryPath + scope)).status, 401);
  const client = createClient(config);
  const view = await client.request<{ facts: { text: string }[] }>(memoryPath + scope);
  assert(view.facts.some(item => item.text === fact));
  await assert.rejects(client.request(memoryPath + '?' + new URLSearchParams({ workspace: outside, assistant: first.id })), /not found/i);
  const messages: string[] = [];
  const chat = new ChatSession(client, event => messages.push(event.text), f.workspace);
  await chat.attach(reader.id);
  messages.length = 0;
  await chat.handle('/memory list');
  assert.match(messages.join('\n'), /JuniperToken/);
  assert.doesNotMatch(messages.join('\n'), /SharedMallow/);
  const configPath = join(f.directory, 'memory-scope-config.json');
  await writeFile(configPath, JSON.stringify(config));
  const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'memory', 'list',
    '--assistant', first.id + '@' + edited.revision, '--workspace', f.workspace, '--config', configPath]);
  assert.match(stdout, /JuniperToken/);
});
