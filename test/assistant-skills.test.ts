import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { fauxAssistantMessage, fauxToolCall, type ToolResultMessage } from '@earendil-works/pi-ai';
import { LocalRuntime } from '../src/runtime.js';
import { pinSkills } from '../src/skills.js';
import { scopedNativeFileArguments } from '../src/remote-policy.js';
import { Workspace } from '../src/workspace.js';
import { hasTool, scriptedFixture, until } from './helpers.js';

const call = (name: string, args: Record<string, unknown>) =>
  fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' });
const decode = (text: string) => text.replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&apos;', "'");
const locations = (context: { messages: { role: string }[] }) =>
  [...new Set([...JSON.stringify(context.messages.filter(message => message.role === 'system')).matchAll(/<location>(.*?)<\/location>/g)]
    .map(match => decode(JSON.parse('"' + match[1] + '"'))))];
const body = (text: string) => '---\nname: assigned-proof\ndescription: Apply the assigned proof method.\n---\n\n' + text + '\n';

test('a named assistant keeps its assigned native Skill in ordinary chat, execution and restart', async t => {
  let phase = 'chat';
  const seen: string[] = [];
  const f = await scriptedFixture(context => {
    const pins = locations(context);
    assert.doesNotMatch(JSON.stringify(context.messages.filter(message => message.role === 'system')), /For scripts from pinned Skills/);
    if (phase === 'no-skills') {
      assert.deepEqual(pins, []);
      return fauxAssistantMessage('No assigned methods used.');
    }
    assert.equal(pins.length, 1, JSON.stringify(pins));
    const path = pins[0]!;
    const input = context.messages.findLastIndex(message => message.role === 'user');
    const results = context.messages.slice(input).filter((message): message is ToolResultMessage => message.role === 'toolResult');
    if (!results.some(result => result.toolName === 'read')) return call('read', {
      path: phase === 'tampered' && process.platform === 'win32' ? path.toUpperCase() : path,
    });
    const original = results.find(result => result.toolName === 'read')!;
    if (phase === 'tampered') {
      assert.equal(original.isError, true);
      assert.doesNotMatch(JSON.stringify(original), /TAMPERED_PROOF_72/);
      return fauxAssistantMessage('Changed package rejected.');
    }
    assert.equal(original.isError, false);
    assert.match(JSON.stringify(original), /ORIGINAL_ASSIGNED_PROOF/);
    assert.doesNotMatch(JSON.stringify(original), /NEW_ASSIGNED_PROOF/);
    seen.push(path);
    if (phase === 'chat') return fauxAssistantMessage('Applied the original proof method.');
    if (hasTool(context, 'task_prepare')) return call('task_prepare', {
      outcome: 'Check the original proof', deliverables: ['Proof summary'], inputs: [], scope: ['Assigned method'], assumptions: [], questions: [],
      criteria: [{ text: 'Read the assigned original method', method: 'inspect' }],
    });
    return call('task_submit', { summary: 'Original proof inspected.', artifacts: [], criteria: [
      { id: 1, status: 'passed', evidence: 'The original assigned Skill was read.' },
    ] });
  });
  let runtime = f.runtime;
  t.after(async () => { await runtime.close(); await f.close(); });
  const source = join(f.workspace, '.kada', 'skills', 'assigned-proof');
  await mkdir(source, { recursive: true });
  await writeFile(join(source, 'SKILL.md'), body('ORIGINAL_ASSIGNED_PROOF'));
  const [catalog] = (await runtime.skillCatalog(f.workspace)).filter(skill => skill.name === 'assigned-proof');
  assert(catalog?.currentVersion);
  const skills = [{ name: catalog.name, version: catalog.currentVersion }];
  const role = await runtime.assistants.create({ workspace: f.workspace, name: 'Assigned reader', instructions: 'Use the assigned method.',
    tools: ['read'], skills });
  const selected = { id: role.id, revision: role.revision };
  const chat = await runtime.create('Read the assigned method.', f.workspace, [], { chat: true, assistant: selected });
  await until(() => runtime.status(chat.id), status => ['answered', 'failed'].includes(status.status));
  assert.equal((await runtime.status(chat.id)).status, 'answered');
  assert.deepEqual(chat.skillSelection, skills);
  assert.equal(chat.skillPins?.pins.length, 1);
  await runtime.close();
  await writeFile(join(source, 'SKILL.md'), body('NEW_ASSIGNED_PROOF'));
  runtime = new LocalRuntime(f.settings, { models: f.models });
  await runtime.recover();
  await runtime.followUp(chat.id, 'Read the original method after restart.', 'original-skill');
  const reopened = await until(() => runtime.status(chat.id), row => row.submission?.requestId === 'user:original-skill' && row.status === 'answered');
  assert.equal(reopened.goal, undefined);
  await assert.rejects(runtime.create('Stale assigned method.', f.workspace, [], { assistant: selected }), /unavailable|changed/i);
  phase = 'no-skills';
  const explicit = await runtime.create('Use no methods for this run.', f.workspace, [], { assistant: selected, skills: [], chat: true });
  const without = await until(() => runtime.status(explicit.id), row => ['answered', 'failed'].includes(row.status));
  assert.equal(without.status, 'answered');
  assert.equal(without.goal, undefined);
  assert.deepEqual(explicit.skillSelection, []);
  await writeFile(join(source, 'SKILL.md'), body('ORIGINAL_ASSIGNED_PROOF'));
  phase = 'execute';
  const task = await runtime.create('Inspect original assigned proof.', f.workspace, [], { prepare: true, assistant: selected });
  const brief = await until(() => runtime.status(task.id), row => row.status === 'awaiting_confirmation');
  await writeFile(join(source, 'SKILL.md'), body('NEW_ASSIGNED_PROOF'));
  await runtime.confirm(task.id, brief.goal!.brief!.revision, brief.briefDigest!);
  const done = await until(() => runtime.status(task.id), row => ['completed', 'failed'].includes(row.status));
  assert.equal(done.status, 'completed', JSON.stringify(done.submission));
  assert.deepEqual(done.goal?.skills?.pins.map(pin => ({ name: pin.name, version: pin.version })), skills);
  assert(seen.length >= 4);
  phase = 'tampered';
  await writeFile(chat.skillPins!.pins[0]!.filePath, body('TAMPERED_PROOF_72'));
  await runtime.followUp(chat.id, 'Reject a changed pinned package.', 'tampered-package');
  const rejected = await until(() => runtime.status(chat.id), row => ['answered', 'failed'].includes(row.status) && row.submission?.requestId === 'user:tampered-package');
  assert.equal(rejected.status, 'answered');
});

test('assigned methods do not advertise unavailable read or script tools to a restricted assistant', async t => {
  const f = await scriptedFixture(context => {
    assert.equal(hasTool(context, 'read'), false);
    assert.equal(hasTool(context, 'run_skill_script'), false);
    assert.deepEqual(locations(context), []);
    if (hasTool(context, 'task_submit')) return call('task_submit', { summary: 'Answered within the fixed tool scope.', artifacts: [] });
    return fauxAssistantMessage('Answered without reading a method.');
  });
  t.after(() => f.close());
  const source = join(f.workspace, '.kada', 'skills', 'assigned-proof');
  await mkdir(source, { recursive: true });
  await writeFile(join(source, 'SKILL.md'), body('ORIGINAL_ASSIGNED_PROOF'));
  const method = (await f.runtime.skillCatalog(f.workspace)).find(skill => skill.name === 'assigned-proof')!;
  const role = await f.runtime.assistants.create({ workspace: f.workspace, name: 'Restricted method reader',
    instructions: 'Stay within the available tools.', tools: [], skills: [{ name: method.name, version: method.currentVersion! }] });
  const assistant = { id: role.id, revision: 1 };
  const chat = await f.runtime.create('Answer within your scope.', f.workspace, [], { chat: true, assistant });
  const answer = await until(() => f.runtime.status(chat.id), row => ['answered', 'failed'].includes(row.status));
  assert.equal(answer.status, 'answered');
  const run = await f.runtime.create('Complete within your scope.', f.workspace, [], { assistant });
  const done = await until(() => f.runtime.status(run.id), row => ['completed', 'failed'].includes(row.status));
  assert.equal(done.status, 'completed', JSON.stringify(done.submission));
});

test('a scoped Skill read permits only that exact package and never grants write access', async t => {
  const f = await scriptedFixture(() => fauxAssistantMessage('Ready.'));
  t.after(() => f.close());
  const workspace = await Workspace.open(f.workspace);
  const source = join(workspace.root, '.kada', 'skills', 'assigned-proof');
  await mkdir(join(source, 'references'), { recursive: true });
  await writeFile(join(source, 'SKILL.md'), body('ORIGINAL_ASSIGNED_PROOF'));
  await writeFile(join(source, 'references', 'proof.txt'), 'ORIGINAL_REFERENCE_81');
  const first = await pinSkills(workspace, join(f.directory, 'first-seat'), undefined, [{ name: 'assigned-proof' }]);
  const other = await pinSkills(workspace, join(f.directory, 'other-seat'), undefined, [{ name: 'assigned-proof' }]);
  const original = first.pins[0]!.filePath;
  const read = (path: string) => scopedNativeFileArguments(workspace, 'read', { path }, workspace.root, ctx, first.pins);
  assert.equal((await read('@' + original)).path, original);
  if (process.platform === 'win32') assert.equal((await read(original.toUpperCase())).path, original.toUpperCase());
  const reference = join(original, '..', 'references', 'proof.txt');
  assert.equal((await read(reference)).path, reference);
  await assert.rejects(read(other.pins[0]!.filePath), /outside/i);
  for (const name of ['write', 'edit']) {
    await assert.rejects(scopedNativeFileArguments(workspace, name, { path: original }, workspace.root, ctx, first.pins), /outside/i);
  }
  await writeFile(reference, 'TAMPERED_REFERENCE_94');
  await assert.rejects(read(original), /changed/i);
  assert.match(await readFile(original, 'utf8'), /ORIGINAL_ASSIGNED_PROOF/);
});

test('an assistant retains its assigned published Skill after a new version, revocation and restart', async t => {
  const f = await scriptedFixture(context => {
    const paths = locations(context);
    assert.equal(paths.length, 1);
    const last = context.messages.findLastIndex(message => message.role === 'user');
    const result = context.messages.slice(last).find((message): message is ToolResultMessage => message.role === 'toolResult' && message.toolName === 'read');
    if (!result) return call('read', { path: paths[0]! });
    assert.equal(result.isError, false);
    assert.match(JSON.stringify(result), /ORIGINAL_ASSIGNED_PROOF/);
    return fauxAssistantMessage('Original published method applied.');
  });
  let runtime = f.runtime;
  t.after(async () => { await runtime.close(); await f.close(); });
  const source = join(f.workspace, '.kada', 'skills', 'assigned-proof');
  await mkdir(source, { recursive: true });
  await writeFile(join(source, 'SKILL.md'), body('ORIGINAL_ASSIGNED_PROOF'));
  const first = await runtime.publishSkill(f.workspace, '.kada/skills/assigned-proof');
  const consumer = join(f.directory, 'published-consumer');
  await mkdir(consumer);
  const role = await runtime.assistants.create({ workspace: consumer, name: 'Published reader', instructions: 'Read your assigned method.',
    tools: ['read'], skills: [{ name: first.name, version: first.version }] });
  const chat = await runtime.create('Apply the published method.', consumer, [], { chat: true, assistant: { id: role.id, revision: 1 } });
  await until(() => runtime.status(chat.id), row => row.status === 'answered');
  await writeFile(join(source, 'SKILL.md'), body('NEW_ASSIGNED_PROOF'));
  const next = await runtime.publishSkill(f.workspace, '.kada/skills/assigned-proof', first.version);
  assert.notEqual(next.version, first.version);
  await runtime.rollbackSkill(next);
  await runtime.rollbackSkill(first);
  await runtime.close();
  runtime = new LocalRuntime(f.settings, { models: f.models });
  await runtime.recover();
  assert.equal((await runtime.skillCatalog(consumer)).find(skill => skill.name === first.name)?.enabled, false);
  await runtime.followUp(chat.id, 'Use the original method after revocation.', 'published-original');
  await until(() => runtime.status(chat.id), row => row.status === 'answered' && row.submission?.requestId === 'user:published-original');
  await assert.rejects(runtime.create('Start a new run with the revoked method.', consumer, [], { assistant: { id: role.id, revision: 1 } }), /disabled/i);
});

test('a cross-project peer reads only its fixed assigned package and rework keeps its original bytes', async t => {
  let role!: { id: string; revision: number };
  let methodFile!: string;
  let privateFile!: string;
  let changed = false;
  let skillReads = 0;
  const f = await scriptedFixture(async context => {
    const system = JSON.stringify(context.messages.filter(message => message.role === 'system'));
    const start = context.messages.findLastIndex(message => message.role === 'user');
    const input = String(context.messages[start]?.content);
    const results = context.messages.slice(start).filter((message): message is ToolResultMessage => message.role === 'toolResult');
    const read = results.filter(result => result.toolName === 'read');
    if (system.includes('ASSIGNED_PEER_482')) {
      const paths = locations(context);
      assert.equal(paths.length, 1);
      if (!read.length) return call('read', { path: paths[0]! });
      assert.equal(read[0]!.isError, false);
      assert.match(JSON.stringify(read[0]), /ORIGINAL_ASSIGNED_PROOF/);
      if (read.length === 1) return call('read', { path: privateFile });
      assert.equal(read[1]!.isError, true);
      assert.doesNotMatch(JSON.stringify(read[1]), /COORDINATOR_PRIVATE_62/);
      skillReads++;
      return fauxAssistantMessage('Original assigned proof checked.');
    }
    if (input.startsWith('ASSISTANT_REPORT ')) {
      const report = JSON.parse(input.slice('ASSISTANT_REPORT '.length));
      if (report.reworkOf) return call('task_submit', { summary: 'Original peer and rework checked.', artifacts: [] });
      if (!changed) {
        changed = true;
        await writeFile(methodFile, body('NEW_ASSIGNED_PROOF'));
        await f.runtime.assistants.update(role.id, { revision: 1, skills: [] });
      }
      if (!results.some(result => result.toolName === 'assistant_rework')) return call('assistant_rework', {
        id: report.id, instructions: 'Check your original method again.',
      });
      return fauxAssistantMessage('Waiting for the original rework.');
    }
    if (!results.some(result => result.toolName === 'assistant_assign')) return call('assistant_assign', {
      assistant: role, instructions: 'Read the fixed assigned method and return the evidence.',
    });
    assert.equal(results.find(result => result.toolName === 'assistant_assign')?.isError, false);
    return fauxAssistantMessage('Waiting for the peer.');
  }, { maxDurationMs: 60_000 });
  t.after(() => f.close());
  const peer = join(f.directory, 'assigned-peer');
  const source = join(peer, '.kada', 'skills', 'assigned-proof');
  await mkdir(source, { recursive: true });
  methodFile = join(source, 'SKILL.md');
  privateFile = join(f.workspace, 'private.txt');
  await writeFile(privateFile, 'COORDINATOR_PRIVATE_62');
  await writeFile(methodFile, body('ORIGINAL_ASSIGNED_PROOF'));
  const method = (await f.runtime.skillCatalog(peer)).find(skill => skill.name === 'assigned-proof')!;
  const saved = await f.runtime.assistants.create({ workspace: peer, name: 'Method peer', instructions: 'ASSIGNED_PEER_482',
    tools: ['read'], skills: [{ name: method.name, version: method.currentVersion! }] });
  role = { id: saved.id, revision: saved.revision };
  const task = await f.runtime.create('Check and recheck the selected peer method.', f.workspace, [], {
    collaborators: [{ ...role, workspace: peer }],
  });
  const done = await until(() => f.runtime.status(task.id), state => ['completed', 'failed'].includes(state.status));
  assert.equal(done.status, 'completed', JSON.stringify(done.submission));
  assert.equal(skillReads, 2);
  assert.equal(done.assistantWork.length, 2);
});

test('local room members use assigned Skill snapshots while paired room turns retain their chat permissions', async t => {
  let peer!: string;
  let reads = 0;
  const trace: unknown[] = [];
  const f = await scriptedFixture(context => {
    const input = JSON.parse(String(context.messages.findLast(message => message.role === 'user')?.content));
    const paths = locations(context);
    trace.push({ input, paths, results: context.messages.filter(message => message.role === 'toolResult') });
    if (input.message === 'Paired check') {
      assert.deepEqual(paths, []);
      assert.equal(hasTool(context, 'read'), false);
      return fauxAssistantMessage('Paired chat answered.');
    }
    assert.equal(paths.length, 1);
    const last = context.messages.findLastIndex(message => message.role === 'user');
    const result = context.messages.slice(last).find((message): message is ToolResultMessage => message.role === 'toolResult' && message.toolName === 'read');
    if (!result) return call('read', { path: paths[0]! });
    assert.equal(result.isError, false);
    assert.match(JSON.stringify(result), /ORIGINAL_ASSIGNED_PROOF/);
    reads++;
    return fauxAssistantMessage('Room method checked.');
  });
  let runtime = f.runtime;
  t.after(async () => { await runtime.close(); await f.close(); });
  peer = join(f.directory, 'room-peer');
  const source = join(peer, '.kada', 'skills', 'assigned-proof');
  await mkdir(source, { recursive: true });
  await writeFile(join(source, 'SKILL.md'), body('ORIGINAL_ASSIGNED_PROOF'));
  const method = (await runtime.skillCatalog(peer)).find(skill => skill.name === 'assigned-proof')!;
  const role = await runtime.assistants.create({ workspace: peer, name: 'Room method reader', instructions: 'Use the selected method.',
    tools: ['read'], skills: [{ name: method.name, version: method.currentVersion! }] });
  const companion = await runtime.assistants.create({ workspace: f.workspace, name: 'Room companion', instructions: 'Read the room.',
    tools: [], skills: [] });
  const room = await runtime.createRoom({ workspace: f.workspace, title: 'Method room',
    members: [{ id: role.id, revision: role.revision, workspace: peer }, { id: companion.id, revision: companion.revision }] });
  await writeFile(join(source, 'SKILL.md'), body('NEW_ASSIGNED_PROOF'));
  await runtime.sendRoomMessage(room.id, { memberId: role.id, message: 'First local check', requestId: 'first-method' });
  const first = await until(() => runtime.roomDetails(room.id), state => state.active === null);
  assert.equal(first.messages.at(-1)?.text, 'Room method checked.', JSON.stringify(trace));
  await runtime.close();
  runtime = new LocalRuntime(f.settings, { models: f.models });
  await runtime.recover();
  await runtime.sendRoomMessage(room.id, { memberId: role.id, message: 'Second local check', requestId: 'second-method' });
  await until(() => runtime.roomDetails(room.id), state => state.messages.filter(message => message.text === 'Room method checked.').length === 2);
  await runtime.sendRoomMessage(room.id, { memberId: role.id, message: 'Paired check', requestId: 'paired-method' }, 'paired');
  await until(() => runtime.roomDetails(room.id), state => state.messages.some(message => message.text === 'Paired chat answered.'));
  assert.equal(reads, 2);
});
