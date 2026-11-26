import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentTools, Type, type ToolResultMessage } from '@earendil-works/pi-ai';
import { createRegistry, defineExtension, defineTool, Harness, UserEntry } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { LocalRuntime } from '../src/runtime.js';
import { hasTool, scriptedFixture, until } from './helpers.js';

const call = (name: string, args: Record<string, unknown>) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' });

test('named assistant pins its model and exact instructions across edits, archive, restart and original task retries', async t => {
  let roleCalls = 0, defaultCalls = 0;
  const f = await scriptedFixture(context => {
    defaultCalls++;
    const system = JSON.stringify(context.messages.filter(message => message.role === 'system'));
    if (context.messages.some(message => message.role === 'user' && message.content === 'Use the new revision.')) assert(system.includes('ROLE_REPLACEMENT_621'));
    else assert(!system.includes('ROLE_ORIGINAL_829') && !system.includes('ROLE_REPLACEMENT_621'));
    return fauxAssistantMessage('Default project model.');
  });
  const specific = fauxProvider({ provider: 'role-specific', models: [{ id: 'reader' }] });
  specific.setResponses(Array.from({ length: 8 }, () => context => {
    roleCalls++; assert(JSON.stringify(context.messages).includes('ROLE_ORIGINAL_829'));
    assert(!hasTool(context, 'write')); return fauxAssistantMessage('Original role model.');
  }));
  f.models.setProvider(specific.provider);
  let runtime = f.runtime;
  t.after(async () => { await runtime.close(); await f.close(); });
  const role = await runtime.assistants.create({ workspace: f.workspace, name: '研究员', instructions: 'ROLE_ORIGINAL_829', model: { provider: 'role-specific', modelId: 'reader' }, tools: ['read'] });
  const options = { chat: true, assistant: { id: role.id, revision: 1 } };
  await assert.rejects(runtime.create('A remote role request.', f.workspace, [], { ...options, remote: true }), { status: 400 });
  await assert.rejects(runtime.create('A role without its project.', undefined, [], options), { status: 400 });
  const chat = await runtime.create('Reply in the selected role.', f.workspace, [], options);
  const answered = await until(() => runtime.status(chat.id), row => ['answered', 'failed'].includes(row.status));
  assert.equal(answered.status, 'answered'); assert.equal(answered.goal, undefined); assert.equal(defaultCalls, 0);
  assert.equal(answered.assistant?.id, role.id); assert.equal(answered.assistant?.revision, 1);
  assert.equal(answered.model.provider, 'role-specific');
  await runtime.assistants.update(role.id, { revision: 1, name: '新版研究员', instructions: 'ROLE_REPLACEMENT_621', model: null, tools: ['read', 'write'] });
  await runtime.close(); runtime = new LocalRuntime(f.settings, { models: f.models }); await runtime.recover();
  const before = roleCalls;
  await runtime.followUp(chat.id, 'Continue the original conversation.', 'original-role');
  const continued = await until(() => runtime.status(chat.id), row => row.status === 'answered' && row.submission?.requestId === 'user:original-role');
  assert.equal(continued.assistant?.instructions, 'ROLE_ORIGINAL_829'); assert.equal(continued.assistant?.name, '研究员');
  assert.equal(roleCalls, before + 1); assert.equal(defaultCalls, 0);
  const replacement = await runtime.create('Use the new revision.', f.workspace, [], { chat: true, assistant: { id: role.id, revision: 2 } });
  await until(() => runtime.status(replacement.id), row => row.status === 'answered');
  assert.equal((await runtime.metadata(replacement.id)).model.provider, f.settings.model!.provider);
  await runtime.assistants.update(role.id, { revision: 2, archived: true });
  const replayCalls = roleCalls + defaultCalls;
  const replay = await runtime.create('Reply in the selected role.', f.workspace, [], { ...options, id: chat.id });
  assert.equal(replay.assistant?.revision, 1); assert.equal(roleCalls + defaultCalls, replayCalls);
  await assert.rejects(runtime.create('A new archived role.', f.workspace, [], { ...options, assistant: { id: role.id, revision: 3 } }), { status: 409 });
  const general = await runtime.create('Use the general assistant.', f.workspace, [], { chat: true });
  await until(() => runtime.status(general.id), row => row.status === 'answered');
  assert.equal((await runtime.metadata(general.id)).assistant, undefined);
});

test('an executing role reads allowed evidence while direct, nested and loaded writes remain blocked', async t => {
  const bridge = defineTool({ name: 'scope_bridge', description: 'Try a nested write.', parameters: Type.Object({}), execute: async (_args, api, context) => {
    const nested = await api.executeTool('write', { path: 'forbidden-nested.txt', content: 'forbidden' }, context);
    return { output: [{ type: 'text' as const, text: JSON.stringify(nested) }], isError: nested.isError };
  } });
  const loader = defineTool({ name: 'scope_loader', description: 'Try to load names outside the role.', parameters: Type.Object({}), execute: async () => ({
    output: [{ type: 'text' as const, text: 'Names found.' }], control: { addTools: ['write', 'bash', 'run_skill_script'] },
  }) });
  const script = defineTool({ name: 'run_skill_script', description: 'Synthetic script effect for scope testing.', parameters: Type.Object({}), execute: async () => {
    await writeFile(join(f.workspace, 'forbidden-skill.txt'), 'forbidden'); return { output: [] };
  } });
  const f = await scriptedFixture(context => {
    assert(!hasTool(context, 'write')); assert(!hasTool(context, 'bash')); assert(!hasTool(context, 'run_skill_script'));
    const results = context.messages.filter((message): message is ToolResultMessage => message.role === 'toolResult');
    if (!results.some(result => result.toolName === 'scope_loader')) return call('scope_loader', {});
    if (!results.some(result => result.toolName === 'write')) return call('write', { path: 'forbidden-direct.txt', content: 'forbidden' });
    if (!results.some(result => result.toolName === 'scope_bridge')) return call('scope_bridge', {});
    if (!results.some(result => result.toolName === 'bash')) return call('bash', { command: "node -e \"require('node:fs').writeFileSync('forbidden-command.txt','bad')\"" });
    if (!results.some(result => result.toolName === 'run_skill_script')) return call('run_skill_script', {});
    if (!results.some(result => result.toolName === 'read')) return call('read', { path: 'seed.txt' });
    for (const name of ['write', 'scope_bridge', 'bash', 'run_skill_script']) assert.equal(results.find(result => result.toolName === name)!.isError, true);
    assert.equal(results.find(result => result.toolName === 'read')!.isError, false);
    return call('task_submit', { summary: 'Allowed evidence read; out-of-scope writes refused.', artifacts: [] });
  }, {}, () => [defineExtension({ name: 'scope_probe_tools', tools: [bridge, loader, script] })]);
  t.after(() => f.close()); await writeFile(join(f.workspace, 'seed.txt'), 'SEED_SCOPE_547');
  const role = await f.runtime.assistants.create({ workspace: f.workspace, name: 'Reader', instructions: 'Read the seed. Keep the fixed role scope.', tools: ['read', 'scope_bridge', 'scope_loader'] });
  const task = await f.runtime.create('Inspect the seed within the selected scope.', f.workspace, [], { assistant: { id: role.id, revision: 1 } });
  const done = await until(() => f.runtime.status(task.id), row => ['completed', 'failed', 'blocked', 'budget_limited'].includes(row.status));
  assert.equal(done.status, 'completed');
  for (const path of ['forbidden-direct.txt', 'forbidden-nested.txt', 'forbidden-command.txt', 'forbidden-skill.txt']) await assert.rejects(readFile(join(f.workspace, path)), { code: 'ENOENT' });
});

test('a role without bash cannot authorize command verification through a normal-chat brief', async t => {
  const f = await scriptedFixture(context => {
    const result = context.messages.find((message): message is ToolResultMessage => message.role === 'toolResult' && message.toolName === 'task_prepare');
    if (result) { assert.equal(result.isError, true); return fauxAssistantMessage('This role can inspect, but cannot run command verification.'); }
    return call('task_prepare', { outcome: 'Read evidence', deliverables: ['A summary'], inputs: [], scope: ['Read seed.txt'], assumptions: [], questions: [],
      criteria: [{ text: 'Checked evidence', method: 'check', verification: { command: 'node --version', inputs: ['seed.txt'], outputs: [] } }] });
  });
  t.after(() => f.close()); await writeFile(join(f.workspace, 'seed.txt'), 'Evidence');
  const role = await f.runtime.assistants.create({ workspace: f.workspace, name: 'Reader', instructions: 'Read only.', tools: ['read'] });
  await assert.rejects(f.runtime.create('Invalid executable acceptance.', f.workspace, [{ type: 'command', path: 'seed.txt', command: 'node --version' }], { assistant: { id: role.id, revision: 1 } }), /Unsupported/);
  const task = await f.runtime.create('Inspect the project.', f.workspace, [], { chat: true, assistant: { id: role.id, revision: 1 } });
  const done = await until(() => f.runtime.status(task.id), row => ['answered', 'awaiting_confirmation', 'failed'].includes(row.status));
  assert.equal(done.status, 'answered'); assert.equal(done.goal, undefined);
});

test('synchronous and background children retain the same role and cannot reacquire native write tools', async t => {
  const seen = new Set<string>();
  const f = await scriptedFixture(context => {
    const results = context.messages.filter((message): message is ToolResultMessage => message.role === 'toolResult');
    if (!hasTool(context, 'task_submit')) {
      assert(JSON.stringify(context.messages).includes('ROLE_WORKER_SCOPE_482'));
      assert(!hasTool(context, 'write')); assert(!hasTool(context, 'bash')); assert(!hasTool(context, 'delegate'));
      const sync = JSON.stringify(context.messages).includes('SYNC_CHILD_921'); seen.add(sync ? 'sync' : 'background');
      if (!sync && !context.messages.some(message => message.role === 'user' && message.content === 'Approved within read scope.')) return call('delegation_ask', { question: 'Which evidence should I use?' });
      if (!results.some(result => result.toolName === 'read')) return call('read', { path: join(f.workspace, 'seed.txt') });
      if (!results.some(result => result.toolName === 'write')) return call('write', { path: 'child-forbidden.txt', content: 'forbidden' });
      assert.equal(results.find(result => result.toolName === 'write')!.isError, true);
      assert.equal(results.find(result => result.toolName === 'read')!.isError, false);
      return fauxAssistantMessage('Child read the original evidence within its fixed scope.');
    }
    assert(!hasTool(context, 'write'));
    if (!results.some(result => result.toolName === 'delegate')) return call('delegate', { tasks: [{ name: 'sync-reader', instructions: 'SYNC_CHILD_921: inspect the seed.' }] });
    if (!results.some(result => result.toolName === 'delegate_background')) return call('delegate_background', { tasks: [{ name: 'background-reader', instructions: 'BACKGROUND_CHILD_263: inspect the seed.' }] });
    const reported = context.messages.some(message => message.role === 'user' && String(message.content).startsWith('Background delegation finished.'));
    if (!reported) return fauxAssistantMessage('Waiting for the original background child.');
    if (!results.some(result => result.toolName === 'task_status')) return call('task_status', { delegation: 'list' });
    return call('task_submit', { summary: 'Both original children used the fixed role scope.', artifacts: [] });
  });
  let runtime = f.runtime;
  t.after(async () => { await runtime.close(); await f.close(); }); await writeFile(join(f.workspace, 'seed.txt'), 'WORKER_SCOPE_SEED');
  const role = await runtime.assistants.create({ workspace: f.workspace, name: 'Reader team', instructions: 'ROLE_WORKER_SCOPE_482', tools: ['read', 'delegate', 'delegate_background'] });
  const task = await runtime.create('Inspect independent evidence with both worker modes.', f.workspace, [], { assistant: { id: role.id, revision: 1 } });
  const waiting = await until(() => runtime.status(task.id), row => row.delegations.some(child => child.question) || ['completed', 'failed', 'blocked', 'budget_limited'].includes(row.status));
  const child = waiting.delegations.find(child => child.question); assert(child?.question);
  await runtime.assistants.update(role.id, { revision: 1, instructions: 'ROLE_REPLACEMENT_826', tools: ['read', 'write', 'delegate', 'delegate_background'] });
  await runtime.close(); runtime = new LocalRuntime(f.settings, { models: f.models }); await runtime.recover();
  await runtime.answerChildQuestion(task.id, child.conversationId, child.question.id, 'role-child-answer', 'Approved within read scope.');
  const done = await until(() => runtime.status(task.id), row => ['completed', 'failed', 'blocked', 'budget_limited'].includes(row.status));
  assert.equal(done.status, 'completed'); assert.deepEqual([...seen].sort(), ['background', 'sync']);
  assert.equal(done.delegations.length, 2); assert(done.delegations.every(child => child.status === 'completed'));
  assert(!(await readdir(join(f.workspace, 'agents'), { recursive: true })).some(path => path.endsWith('child-forbidden.txt')));
});

test('an allowed writer goes from role chat through the original brief confirmation to a checked artifact', async t => {
  const f = await scriptedFixture(context => {
    assert(JSON.stringify(context.messages).includes('ROLE_WRITER_713'));
    if (!hasTool(context, 'task_submit')) {
      assert(!hasTool(context, 'write'));
      return call('task_prepare', { outcome: 'Save the approved artifact', deliverables: ['result.txt'], inputs: [], scope: ['Write result.txt'], assumptions: [], questions: [],
        criteria: [{ text: 'The file contains ROLE_OUTPUT_613', method: 'inspect' }], checks: [{ type: 'file_contains', path: 'result.txt', text: 'ROLE_OUTPUT_613' }] });
    }
    assert(hasTool(context, 'write'));
    if (!context.messages.some(message => message.role === 'toolResult' && message.toolName === 'write')) return call('write', { path: 'result.txt', content: 'ROLE_OUTPUT_613' });
    return call('task_submit', { summary: 'Approved artifact saved.', artifacts: ['result.txt'], criteria: [{ id: 1, status: 'passed', evidence: 'result.txt contains the required marker.' }] });
  });
  t.after(() => f.close());
  const role = await f.runtime.assistants.create({ workspace: f.workspace, name: 'Writer', instructions: 'ROLE_WRITER_713', tools: ['read', 'write'] });
  assert.equal((await f.runtime.list()).length, 0);
  const task = await f.runtime.create('Save the requested file.', f.workspace, [], { chat: true, assistant: { id: role.id, revision: 1 } });
  const waiting = await until(() => f.runtime.status(task.id), row => ['awaiting_confirmation', 'failed'].includes(row.status));
  assert.equal(waiting.status, 'awaiting_confirmation'); await assert.rejects(readFile(join(f.workspace, 'result.txt')), { code: 'ENOENT' });
  await f.runtime.confirm(task.id, waiting.goal!.brief!.revision, waiting.briefDigest!);
  const done = await until(() => f.runtime.status(task.id), row => ['completed', 'failed', 'blocked'].includes(row.status));
  assert.equal(done.status, 'completed'); assert.equal(done.assistant?.revision, 1);
  assert.equal(await readFile(join(f.workspace, 'result.txt'), 'utf8'), 'ROLE_OUTPUT_613');
});

test('a role selects only its permitted MCP schema from a large native catalog and never dispatches a forbidden tool', async t => {
  let permitted = '', forbidden = '';
  const f = await scriptedFixture(context => {
    assert.deepEqual(getCurrentTools(context.messages).filter(tool => tool.name.startsWith('mcp_')).map(tool => tool.name), [permitted]);
    const results = context.messages.filter((message): message is ToolResultMessage => message.role === 'toolResult');
    if (!results.some(result => result.toolName === forbidden)) return call(forbidden, {});
    if (!results.some(result => result.toolName === permitted)) return call(permitted, {});
    assert.equal(results.find(result => result.toolName === forbidden)!.isError, true);
    const allowed = results.find(result => result.toolName === permitted)!;
    assert.equal(allowed.isError, false); assert(JSON.stringify(allowed.content).includes('ROLE_RECORD_17'));
    return call('task_submit', { summary: 'ROLE_RECORD_17', artifacts: [] });
  });
  t.after(() => f.close());
  const effects = join(f.directory, 'mcp-effects.txt');
  const catalog = Array.from({ length: 21 }, (_, i) => ({ name: 'record_' + i, description: 'Read record ' + i, inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } }));
  const fixture = `const fs=require('node:fs'), rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const r=JSON.parse(line);if(r.id===undefined)return;let result;
if(r.method==='initialize')result={protocolVersion:r.params.protocolVersion,serverInfo:{name:'role-catalog',version:'1'},capabilities:{tools:{}}};
if(r.method==='tools/list')result={tools:${JSON.stringify(catalog)}};
if(r.method==='tools/call'){fs.appendFileSync(process.argv[1],r.params.name+String.fromCharCode(10));result={content:[{type:'text',text:r.params.name==='record_17'?'ROLE_RECORD_17':'Forbidden record'}]};}
console.log(JSON.stringify({jsonrpc:'2.0',id:r.id,result}));});`;
  await f.runtime.mcp.configure({ id: 'role-scope', transport: 'stdio', command: process.execPath, args: ['-e', fixture, effects] });
  const tested = await f.runtime.mcp.test('role-scope'); await f.runtime.mcp.enable('role-scope', catalog.map(tool => tool.name), tested.revision);
  const tools = await f.runtime.mcp.tools(await f.runtime.mcp.pins(f.workspace));
  permitted = tools.find(tool => tool.name.includes('_record_17_'))!.name; forbidden = tools.find(tool => tool.name.includes('_record_18_'))!.name;
  const role = await f.runtime.assistants.create({ workspace: f.workspace, name: 'One record', instructions: 'Read only the selected record.', tools: [permitted] });
  const task = await f.runtime.create('Read the one allowed record.', f.workspace, [], { assistant: { id: role.id, revision: 1 } });
  const done = await until(() => f.runtime.status(task.id), row => ['completed', 'failed', 'blocked', 'budget_limited'].includes(row.status));
  assert.equal(done.status, 'completed'); assert.equal(done.mcpDiscovery, 'deferred');
  assert.equal(await readFile(effects, 'utf8'), 'record_17\n');
});

test('native Pi compaction cannot replace an original role with a later catalog revision', async t => {
  const f = await scriptedFixture(context => {
    const system = JSON.stringify(context.messages.filter(message => message.role === 'system'));
    if (system.includes('context summarization assistant')) return fauxAssistantMessage('The original task is waiting to inspect its evidence.');
    assert(system.includes('ROLE_COMPACT_ORIGINAL_741')); assert(!hasTool(context, 'write'));
    if (!context.messages.some(message => message.role === 'user' && message.content === 'Continue original after compaction.')) return call('task_blocked', { reason: 'Wait for evidence.' });
    const results = context.messages.filter((message): message is ToolResultMessage => message.role === 'toolResult');
    if (!results.some(result => result.toolName === 'write')) return call('write', { path: 'forbidden-compact.txt', content: 'forbidden' });
    if (!results.some(result => result.toolName === 'read')) return call('read', { path: 'seed.txt' });
    assert.equal(results.find(result => result.toolName === 'write')!.isError, true);
    return call('task_submit', { summary: 'Original role and evidence retained.', artifacts: [] });
  });
  let runtime = f.runtime;
  t.after(async () => { await runtime.close(); await f.close(); }); await writeFile(join(f.workspace, 'seed.txt'), 'Original evidence');
  const role = await runtime.assistants.create({ workspace: f.workspace, name: 'Original reader', instructions: 'ROLE_COMPACT_ORIGINAL_741', tools: ['read'] });
  const task = await runtime.create('Inspect the original evidence.', f.workspace, [], { assistant: { id: role.id, revision: 1 } });
  await until(() => runtime.status(task.id), row => row.status === 'blocked'); await runtime.close();
  const storage = await openNodeSqliteStorage(join(f.directory, 'tasks', task.id, 'session.sqlite'));
  const harness = await Harness.open(storage, { models: f.models, registry: createRegistry(), settings: { compaction: { enabled: true, keepRecentTokens: 256, backgroundTokens: 0 } } }, ctx);
  try {
    const root = await harness.root(ctx);
    for (let i = 0; i < 2; i++) {
      const input = await root.submit({ type: 'write', entry: { kind: UserEntry.kind, model: [{ role: 'user', content: 'Archived material. '.repeat(3000), timestamp: Date.now() }] } }, ctx);
      assert.equal((await input.wait(ctx)).status, 'done');
    }
    const compaction = await root.compact('Keep original task facts.', ctx), outcome = (await harness.waitForTask(compaction, ctx)).state.outcome;
    assert(outcome.status === 'completed' && outcome.result.submissionId !== undefined);
    assert.equal((await (await harness.submission(outcome.result.submissionId, ctx))!.wait(ctx)).status, 'done');
  } finally { await harness.close(ctx); }
  runtime = new LocalRuntime(f.settings, { models: f.models });
  await runtime.assistants.update(role.id, { revision: 1, instructions: 'ROLE_COMPACT_REPLACEMENT_562', tools: ['read', 'write'] });
  await runtime.recover(); await runtime.followUp(task.id, 'Continue original after compaction.', 'after-compact');
  const done = await until(() => runtime.status(task.id), row => ['completed', 'failed', 'budget_limited'].includes(row.status));
  assert.equal(done.status, 'completed'); assert.equal(done.assistant?.revision, 1); assert(done.rootCompactions > 0);
  await assert.rejects(readFile(join(f.workspace, 'forbidden-compact.txt')), { code: 'ENOENT' });
});
