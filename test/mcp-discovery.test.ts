import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxToolCall, getCurrentTools } from '@earendil-works/pi-ai';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { UserEntry } from '@earendil-works/pi-durable';
import { LocalRuntime } from '../src/runtime.js';
import { scriptedFixture, until } from './helpers.js';

const tools = Array.from({ length: 21 }, (_, index) => ({ name: 'lookup' + index,
  description: 'Look up synthetic record ' + index, inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }));
const server = `const fs=require('node:fs'); const input=require('node:readline').createInterface({input:process.stdin});
input.on('line', line=>{const r=JSON.parse(line);if(r.id===undefined)return;let result;
if(r.method==='initialize')result={protocolVersion:r.params.protocolVersion,serverInfo:{name:'catalog-fixture',version:'1'},capabilities:{tools:{}}};
if(r.method==='tools/list')result={tools:${JSON.stringify([...tools, { name: 'private-tool', description: 'PRIVATE_UNAUTHORIZED_TOOL', inputSchema: { type: 'object' } }])}};
if(r.method==='tools/call'){fs.appendFileSync(process.argv[1],r.params.name+'\\n');result={content:[{type:'text',text:r.params.arguments.text}]};}
console.log(JSON.stringify({jsonrpc:'2.0',id:r.id,result}));});`;
const call = (name: string, args: Record<string, unknown>) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' });
async function configure(runtime: LocalRuntime, effects: string, count = 21) {
  await runtime.mcp.configure({ id: 'catalog', transport: 'stdio', command: process.execPath, args: ['-e', server, effects] });
  const checked = await runtime.mcp.test('catalog');
  await runtime.mcp.enable('catalog', tools.slice(0, count).map(tool => tool.name), checked.revision);
  return checked.revision;
}

test('a large MCP snapshot uses native discovery and retains loaded tools after reopen', async t => {
  const offered: string[][] = [];
  let afterRestart = false;
  const f = await scriptedFixture(context => {
    if (context.messages.some(message => message.role === 'system' && JSON.stringify(message).includes('context summarization assistant'))) return fauxAssistantMessage('The selected MCP record was checked.');
    const names = getCurrentTools(context.messages).map(tool => tool.name); offered.push(names);
    const results = context.messages.filter(message => message.role === 'toolResult');
    if (afterRestart) {
      const selected = names.find(name => name.startsWith('mcp_catalog_lookup20_'));
      assert(selected);
      if (!results.some(message => message.toolName === selected)) return call(selected, { text: 'Record after compaction' });
      return call('task_submit', { summary: 'Reused the loaded tool', artifacts: [] });
    }
    if (!results.some(message => message.toolName === 'tool_search')) return call('tool_search', { query: 'mcp_catalog_lookup20', limit: 1 });
    const selected = names.find(name => name.startsWith('mcp_catalog_lookup20_'));
    assert(selected, 'native discovery must expose the selected pinned tool');
    if (!results.some(message => message.toolName === selected)) return call(selected, { text: 'Selected record' });
    return call('task_submit', { summary: 'Looked up one record', artifacts: [] });
  });
  let runtime = f.runtime;
  t.after(async () => { await runtime.close(); await f.close(); });
  const effects = join(f.directory, 'effects.txt'); await configure(runtime, effects);
  const task = await runtime.create('Look up synthetic record 20.', f.workspace);
  const done = await until(() => runtime.status(task.id), row => ['completed', 'failed'].includes(row.status));
  assert.equal(done.status, 'completed');
  assert.equal(done.mcpDiscovery, 'deferred');
  assert(offered[0].includes('tool_search'));
  assert.equal(offered[0].filter(name => name.startsWith('mcp_catalog_')).length, 0);
  assert(offered[1].some(name => name.startsWith('mcp_catalog_lookup20_')));
  assert(offered.every(names => !names.includes('delegation_ask') && !names.some(name => name.includes('private'))));
  assert.equal(await readFile(effects, 'utf8'), 'lookup20\n');
  const active = runtime['active'].get(task.id)!;
  for (let index = 0; index < 2; index++) {
    const write = await active.root.submit({ type: 'write', entry: { kind: UserEntry.kind,
      model: [{ role: 'user', content: 'Archived observation. '.repeat(3000), timestamp: Date.now() }] } }, BACKGROUND_CONTEXT);
    await write.wait(BACKGROUND_CONTEXT);
  }
  const compact = await active.root.compact('Keep the record result.', BACKGROUND_CONTEXT);
  const outcome = (await active.harness.waitForTask(compact, BACKGROUND_CONTEXT)).state.outcome;
  assert.equal(outcome.status, 'completed');
  if (outcome.status === 'completed' && outcome.result.submissionId !== undefined) await (await active.harness.submission(outcome.result.submissionId, BACKGROUND_CONTEXT))!.wait(BACKGROUND_CONTEXT);
  await runtime.close(); runtime = new LocalRuntime(f.settings, { models: f.models }); await runtime.recover();
  afterRestart = true;
  await runtime.followUp(task.id, 'Use the same loaded tool.', 'reopen');
  await until(() => runtime.status(task.id), row => row.status === 'completed' && row.submission?.requestId === 'user:reopen');
  assert(offered.at(-1)!.some(name => name.startsWith('mcp_catalog_lookup20_')));
  assert.equal(await readFile(effects, 'utf8'), 'lookup20\nlookup20\n');
});

test('twenty tools stay direct, and a historical large task keeps its original direct schemas', async t => {
  const offered: string[][] = [];
  const f = await scriptedFixture(context => {
    offered.push(getCurrentTools(context.messages).map(tool => tool.name));
    return call('task_submit', { summary: 'Recorded tools', artifacts: [] });
  });
  let runtime = f.runtime;
  t.after(async () => { await runtime.close(); await f.close(); });
  await configure(runtime, join(f.directory, 'effects.txt'), 20);
  const small = await runtime.create('Small catalog', f.workspace);
  await until(() => runtime.status(small.id), row => row.status === 'completed');
  assert.equal(offered[0].filter(name => name.startsWith('mcp_catalog_')).length, 20);
  assert(!offered[0].includes('tool_search'));
  await runtime.mcp.enable('catalog', tools.map(tool => tool.name), (await runtime.mcp.list())[0].revision);
  const large = await runtime.create('Original large task', f.workspace);
  await until(() => runtime.status(large.id), row => row.status === 'completed');
  const meta = await runtime.metadata(large.id); delete meta.mcpDiscovery;
  await runtime.close(); await writeFile(join(f.directory, 'tasks', large.id, 'task.json'), JSON.stringify(meta));
  runtime = new LocalRuntime(f.settings, { models: f.models }); await runtime.recover();
  await runtime.followUp(large.id, 'Continue original task.', 'historical');
  await until(() => runtime.status(large.id), row => row.status === 'completed' && row.submission?.requestId === 'user:historical');
  assert.equal(offered.at(-1)!.filter(name => name.startsWith('mcp_catalog_')).length, 21);
  assert(!offered.at(-1)!.includes('tool_search'));
});

test('a loaded deferred MCP action still requires an exact owner approval across reopen', async t => {
  let requested = false;
  const f = await scriptedFixture(context => {
    const names = getCurrentTools(context.messages).map(tool => tool.name);
    if (!context.messages.some(message => message.role === 'toolResult' && message.toolName === 'tool_search')) return call('tool_search', { query: 'mcp_catalog_lookup20', limit: 1 });
    const selected = names.find(name => name.startsWith('mcp_catalog_lookup20_'));
    assert(selected);
    if (!requested) { requested = true; return call(selected, { text: 'approved exact value' }); }
    return call('task_submit', { summary: 'Owner approved the selected record', artifacts: [] });
  });
  let runtime = f.runtime;
  t.after(async () => { await runtime.close(); await f.close(); });
  const effects = join(f.directory, 'effects.txt'), revision = await configure(runtime, effects);
  await runtime.mcp.setApproval('catalog', ['lookup20'], revision);
  const task = await runtime.create('Run one approved record lookup.', f.workspace);
  const waiting = await until(() => runtime.status(task.id), row => row.status === 'waiting_user' && row.tasks.length === 0);
  const approval = waiting.approvals[0];
  assert.deepEqual(approval.arguments, { text: 'approved exact value' });
  await assert.rejects(readFile(effects), { code: 'ENOENT' });
  await runtime.close(); runtime = new LocalRuntime(f.settings, { models: f.models }); await runtime.recover();
  await runtime.decideApproval(task.id, approval.id, 'allow', approval.digest);
  await runtime.decideApproval(task.id, approval.id, 'allow', approval.digest);
  const done = await until(() => runtime.status(task.id), row => row.status === 'completed');
  assert.equal(done.approvals[0].status, 'completed');
  assert.equal(await readFile(effects, 'utf8'), 'lookup20\n');
});

test('discovery excludes unallowed tools and a loaded tool cannot execute after connection revocation', async t => {
  let runtime: LocalRuntime;
  const f = await scriptedFixture(async context => {
    const names = getCurrentTools(context.messages).map(tool => tool.name);
    const results = context.messages.filter(message => message.role === 'toolResult');
    if (!results.some(message => message.toolName === 'tool_search')) return call('tool_search', { query: 'mcp_catalog_lookup20', limit: 1 });
    const selected = names.find(name => name.startsWith('mcp_catalog_lookup20_'));
    assert(selected);
    if (!results.some(message => message.toolName === selected)) {
      await runtime.mcp.disable('catalog');
      return call(selected, { text: 'must not run' });
    }
    assert(results.find(message => message.toolName === selected)?.isError);
    return call('task_submit', { summary: 'Revocation was respected', artifacts: [] });
  });
  runtime = f.runtime;
  t.after(() => f.close());
  const effects = join(f.directory, 'effects.txt'); await configure(runtime, effects);
  const task = await runtime.create('Test the revoked record lookup.', f.workspace);
  const done = await until(() => runtime.status(task.id), row => row.status === 'completed');
  assert(!JSON.stringify(done.messages).includes('PRIVATE_UNAUTHORIZED_TOOL'));
  await assert.rejects(readFile(effects), { code: 'ENOENT' });
});

test('native discovery cannot expose child-only questions and synchronous workers retain their own MCP discovery', async t => {
  let childCalls = 0;
  const f = await scriptedFixture(context => {
    const names = getCurrentTools(context.messages).map(tool => tool.name);
    const results = context.messages.filter(message => message.role === 'toolResult');
    assert(!names.includes('delegation_ask'));
    if (!names.includes('delegate')) {
      childCalls++;
      assert(names.includes('tool_search'));
      if (!results.some(message => message.toolName === 'tool_search')) return call('tool_search', { query: 'mcp_catalog_lookup20', limit: 1 });
      const selected = names.find(name => name.startsWith('mcp_catalog_lookup20_')); assert(selected);
      if (!results.some(message => message.toolName === selected)) return call(selected, { text: 'Child record' });
      return fauxAssistantMessage('Child record checked.');
    }
    if (!results.some(message => message.toolName === 'tool_search')) return call('tool_search', { query: 'delegation_ask PRIVATE_UNAUTHORIZED_TOOL', limit: 8 });
    const searched = results.find(message => message.toolName === 'tool_search')!;
    assert.match(JSON.stringify(searched.content), /No matching tools/);
    if (!results.some(message => message.toolName === 'delegate')) return call('delegate', { tasks: [{ name: 'worker', instructions: 'Use discovery to check record 20.' }] });
    return call('task_submit', { summary: 'Child discovery kept its scope', artifacts: [] });
  });
  t.after(() => f.close());
  const effects = join(f.directory, 'effects.txt'); await configure(f.runtime, effects);
  const task = await f.runtime.create('Inspect one independent record.', f.workspace);
  await until(() => f.runtime.status(task.id), row => row.status === 'completed');
  assert.equal(childCalls, 3);
  assert.equal(await readFile(effects, 'utf8'), 'lookup20\n');
});

test('preparation and ordinary chat never receive deferred MCP schemas or discovery', async t => {
  const f = await scriptedFixture(context => {
    const names = getCurrentTools(context.messages).map(tool => tool.name);
    assert(!names.includes('tool_search'));
    assert(!names.some(name => name.startsWith('mcp_catalog_')));
    return call('task_prepare', { outcome: 'Inspect the project', deliverables: ['Local notes'], inputs: [],
      criteria: [{ text: 'Project reviewed', method: 'inspect' }], scope: ['Current project'], assumptions: [], questions: [] });
  });
  t.after(() => f.close());
  await configure(f.runtime, join(f.directory, 'effects.txt'));
  for (const options of [{ prepare: true }, { chat: true }]) {
    const task = await f.runtime.create('Prepare a review.', f.workspace, [], options);
    await until(() => f.runtime.status(task.id), row => row.status === 'awaiting_confirmation');
  }
});

test('background workers keep their own question tool while the deferred-MCP parent cannot discover it', async t => {
  const f = await scriptedFixture(context => {
    const names = getCurrentTools(context.messages).map(tool => tool.name);
    const users = context.messages.filter(message => message.role === 'user').map(message => String(message.content));
    if (!names.includes('delegate_background')) {
      assert(names.includes('delegation_ask'));
      assert(!names.includes('tool_search'));
      assert(!names.some(name => name.startsWith('mcp_catalog_')));
      if (users.includes('Use November.')) return fauxAssistantMessage('November checked.');
      return call('delegation_ask', { question: 'Which month?' });
    }
    assert(!names.includes('delegation_ask'));
    if (users.some(message => message.startsWith('Background delegation finished.'))) return call('task_submit', { summary: 'Used November evidence', artifacts: [] });
    if (!context.messages.some(message => message.role === 'toolResult' && message.toolName === 'delegate_background')) return call('delegate_background', {
      tasks: [{ name: 'worker', instructions: 'Check the monthly source.' }],
    });
    return fauxAssistantMessage('Waiting for the month.');
  });
  t.after(() => f.close());
  await configure(f.runtime, join(f.directory, 'effects.txt'));
  const task = await f.runtime.create('Check the monthly source with a worker.', f.workspace);
  const waiting = await until(() => f.runtime.status(task.id), row => row.delegations[0]?.status === 'waiting_input');
  const child = waiting.delegations[0];
  await f.runtime.answerChildQuestion(task.id, child.conversationId, child.question!.id, 'month-answer', 'Use November.');
  await until(() => f.runtime.status(task.id), row => row.status === 'completed');
});
