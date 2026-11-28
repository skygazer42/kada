import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { fauxAssistantMessage, fauxToolCall, Type, type ToolResultMessage } from '@earendil-works/pi-ai';
import { defineExtension, defineTool } from '@earendil-works/pi-durable';
import { ComputerBridge } from '../src/computer.js';
import { LocalRuntime, type ComputerRuntime } from '../src/runtime.js';
import { fakeRoutineClock, hasTool, scriptedFixture, until } from './helpers.js';

const call = (name: string, args = {}) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' });
const snapshot = 'computer_0_agent_browser_snapshot';
const tools = ['computer_begin', 'computer_end', 'computer_request_sign_in', snapshot];
const driver = (session: string) => ({ command: process.execPath,
  args: ['--import', 'tsx', fileURLToPath(new URL('./fixtures/computer-server.ts', import.meta.url)), '--browser', '--named'],
  env: { AGENT_BROWSER_SESSION: session }, tools: ['agent_browser_snapshot', 'agent_browser_click'], observationTools: ['agent_browser_snapshot'] });

test('assistant browser defaults and explicit overrides keep their own handoffs after role edits and restart', async t => {
  const alpha = new ComputerBridge(true), beta = new ComputerBridge(true);
  await alpha.connect(driver('alpha'));
  await beta.connect(driver('beta'));
  t.after(async () => { await alpha.close(); await beta.close(); });
  const browserProfiles = new Map([['alpha', alpha], ['beta', beta]]);
  const f = await scriptedFixture(context => {
    const original = String(context.messages.find(message => message.role === 'user' && /EXPECT_BROWSER=/.test(String(message.content)))?.content);
    const expected = /EXPECT_BROWSER=(\w+)/.exec(original)![1]!;
    if (expected === 'none') {
      assert.equal(hasTool(context, 'computer_begin'), false);
      return call('task_submit', { summary: 'No browser was selected.', artifacts: [] });
    }
    const after = context.messages.findLastIndex(message => message.role === 'user' && String(message.content).includes('The user finished the requested browser step'));
    const results = context.messages.slice(after + 1).filter((message): message is ToolResultMessage => message.role === 'toolResult');
    for (const result of results) assert.equal(result.isError, false, JSON.stringify(result));
    if (!results.some(result => result.toolName === 'computer_begin')) return call('computer_begin');
    const read = results.find(result => result.toolName === snapshot);
    if (!read) return call(snapshot, { interactive: true });
    assert.match(JSON.stringify(read), new RegExp('fixture session ' + expected));
    if (after < 0 && !original.includes('DIRECT')) return call('computer_request_sign_in', { step: 'verification' });
    return call('task_submit', { summary: 'The originally selected browser was observed.', artifacts: [] });
  }, {}, () => [], { browserProfiles });
  let runtime = f.runtime;
  t.after(async () => { await runtime.close(); await f.close(); });
  const roleA = await runtime.assistants.create({ workspace: f.workspace, name: 'Work browser', instructions: 'Use the selected browser.', tools, browserProfile: 'alpha' });
  const roleB = await runtime.assistants.create({ workspace: f.workspace, name: 'Personal browser', instructions: 'Use the selected browser.', tools, browserProfile: 'beta' });
  const input = { assistant: { id: roleA.id, revision: 1 } };
  const a = await runtime.create('EXPECT_BROWSER=alpha', f.workspace, [], input);
  const b = await runtime.create('EXPECT_BROWSER=beta', f.workspace, [], { assistant: { id: roleB.id, revision: 1 } });
  assert.equal(a.browserProfile, 'alpha');
  assert.equal(a.assistant?.browserProfile, 'alpha');
  assert.equal(b.browserProfile, 'beta');
  const waiting = (id: string) => until(() => runtime.status(id), row => ['waiting_user', 'failed'].includes(row.status) && row.submission?.status === 'done');
  const [aWait, bWait] = await Promise.all([waiting(a.id), waiting(b.id)]);
  await runtime.browserSignIn(a.id, aWait.userQuestion!.id, 'takeover');
  await runtime.browserSignIn(b.id, bWait.userQuestion!.id, 'takeover');
  await runtime.assistants.update(roleA.id, { revision: 1, browserProfile: 'beta' });
  await runtime.assistants.update(roleB.id, { revision: 1, browserProfile: null });
  await runtime.close();
  runtime = new LocalRuntime(f.settings, { models: f.models, browserProfiles });
  await runtime.recover();
  assert.equal(alpha.status().mode, 'user');
  assert.equal(beta.status().mode, 'user');
  assert.equal((await runtime.create('EXPECT_BROWSER=alpha', f.workspace, [], { ...input, id: a.id })).id, a.id);
  await runtime.browserSignIn(a.id, aWait.userQuestion!.id, 'continue');
  await until(() => runtime.status(a.id), row => row.status === 'completed');
  assert.equal(beta.status().mode, 'user');
  await runtime.browserSignIn(b.id, bWait.userQuestion!.id, 'continue');
  await until(() => runtime.status(b.id), row => row.status === 'completed');
  const current = { assistant: { id: roleA.id, revision: 2 } };
  const overridden = await runtime.create('EXPECT_BROWSER=alpha DIRECT', f.workspace, [], { ...current, browserProfile: 'alpha' });
  assert.equal(overridden.assistant?.browserProfile, 'beta');
  assert.equal(overridden.browserProfile, 'alpha');
  await until(() => runtime.status(overridden.id), row => row.status === 'completed');
  const selected = await runtime.create('EXPECT_BROWSER=beta DIRECT', f.workspace, [], current);
  assert.equal(selected.browserProfile, 'beta');
  await until(() => runtime.status(selected.id), row => row.status === 'completed');
  const cleared = await runtime.create('EXPECT_BROWSER=none DIRECT', f.workspace, [], { assistant: { id: roleB.id, revision: 2 } });
  assert.equal(cleared.browserProfile, undefined);
  await until(() => runtime.status(cleared.id), row => row.status === 'completed');
});

const probeComputer = (profile: string): ComputerRuntime => ({
  browserKey: () => 'driver-' + profile, browserSession: () => 'session-' + profile, release() {},
  forTask: () => defineExtension({ name: 'local_computer', tools: [defineTool({ name: 'computer_probe',
    description: 'Read a synthetic browser identity.', parameters: Type.Object({}),
    execute: async () => ({ output: [{ type: 'text' as const, text: profile }] }),
  })] }),
});

test('an unavailable assistant browser never falls through to the working host browser', async t => {
  const offline: ComputerRuntime = { forTask() { assert.fail('The offline browser must not execute.'); }, release() {} };
  const f = await scriptedFixture(() => assert.fail('An unavailable browser must fail before model dispatch.'), {}, () => [], {
    computer: probeComputer('host'), browserProfiles: new Map([['offline', offline]]),
  });
  t.after(() => f.close());
  const role = await f.runtime.assistants.create({ workspace: f.workspace, name: 'Offline browser', instructions: 'Use only the selected browser.',
    tools: [], browserProfile: 'offline' });
  await assert.rejects(f.runtime.create('Use the selected offline browser.', f.workspace, [], { assistant: { id: role.id, revision: 1 } }), /browser profile.*unavailable/i);
  assert.equal((await f.runtime.list()).length, 0);
});

test('preparation, routine admission and related opinions retain the effective browser without granting new tools', async t => {
  const browserProfiles = new Map([['alpha', probeComputer('alpha')], ['beta', probeComputer('beta')]]);
  const clock = fakeRoutineClock(Date.UTC(2026, 10, 28, 11, 59));
  const f = await scriptedFixture(context => {
    const input = String(context.messages.find(message => message.role === 'user')?.content);
    if (input === 'Seed the source.') {
      assert.equal(hasTool(context, 'computer_probe'), false);
      return fauxAssistantMessage('Source ready.');
    }
    if (hasTool(context, 'task_prepare')) {
      assert.equal(hasTool(context, 'computer_probe'), false);
      return call('task_prepare', { outcome: 'Observe the selected browser.', deliverables: ['Browser identity'], inputs: [],
        scope: ['Synthetic browser'], assumptions: [], questions: [], criteria: [{ text: 'Observe the selected identity.', method: 'inspect' }] });
    }
    const result = context.messages.find((message): message is ToolResultMessage => message.role === 'toolResult' && message.toolName === 'computer_probe');
    if (!result) return call('computer_probe');
    assert.equal(result.isError, false);
    assert.match(JSON.stringify(result), input.includes('alpha') ? /alpha/ : /beta/);
    return call('task_submit', { summary: 'Observed the selected browser identity.', artifacts: [],
      criteria: [{ id: 1, status: 'passed', evidence: 'Read the selected synthetic browser identity.' }] });
  }, {}, () => [], { browserProfiles, routineClock: clock });
  t.after(() => f.close());
  const runtime = f.runtime;
  const role = await runtime.assistants.create({ workspace: f.workspace, name: 'Browser reader', instructions: 'Use your browser.', tools: ['computer_probe'], browserProfile: 'alpha' });
  const assistant = { id: role.id, revision: 1 };
  const preparing = await runtime.create('Observe alpha.', f.workspace, [], { chat: true, assistant });
  const brief = await until(() => runtime.status(preparing.id), row => row.status === 'awaiting_confirmation');
  await runtime.assistants.update(role.id, { revision: 1, browserProfile: 'beta' });
  await runtime.confirm(preparing.id, brief.goal!.brief!.revision, brief.briefDigest!);
  await until(() => runtime.status(preparing.id), row => row.status === 'completed');
  const rule = await runtime.routines.create({ id: 'browser-routine', action: 'task', objective: 'Observe beta.', workspace: f.workspace,
    assistant: { id: role.id, revision: 2 }, schedule: { kind: 'daily', time: '12:00', timeZone: 'UTC' },
    budget: { maxEstimatedCostUsd: 1, maxDurationMs: 30_000 } });
  const occurrence = await runtime.routines.runNow(rule.id, 'browser-routine-original');
  await until(() => runtime.routines.history(rule.id), rows => rows.some(row => row.id === occurrence.id && row.status === 'started'));
  const routine = await until(() => runtime.status(occurrence.taskId!), row => row.status === 'completed');
  assert.equal(routine.browserProfile, 'beta');
  const source = await runtime.create('Seed the source.', f.workspace, [], { chat: true, assistant: { id: role.id, revision: 2 }, browserProfile: 'alpha' });
  await until(() => runtime.status(source.id), row => row.status === 'answered');
  const request = { title: 'Browser opinion', message: 'Observe alpha.', requestId: 'source-browser-opinion', modelSelection: f.settings.model };
  const opinion = await runtime.startThread(source.id, request);
  const pinned = await runtime.metadata(opinion.id);
  assert.equal(pinned.browserProfile, 'alpha');
  assert.equal(pinned.browserDriver, source.browserDriver);
  browserProfiles.set('alpha', probeComputer('replacement'));
  await assert.rejects(runtime.startThread(source.id, { ...request, requestId: 'source-driver-changed' }), /original.*browser|browser.*changed/i);
  assert.equal((await runtime.startThread(source.id, request)).id, opinion.id);
  browserProfiles.set('alpha', probeComputer('alpha'));
  browserProfiles.delete('beta');
  await assert.rejects(runtime.create('Missing default.', f.workspace, [], { assistant: { id: role.id, revision: 2 } }), /browser profile/i);
  const validOverride = await runtime.create('Observe alpha.', f.workspace, [], { assistant: { id: role.id, revision: 2 }, browserProfile: 'alpha' });
  assert.equal(validOverride.browserProfile, 'alpha');
  await until(() => runtime.status(validOverride.id), row => row.status === 'completed');
});

test('a member browser default cannot acquire the coordinator browser or paired room execution tools', async t => {
  const browserProfiles = new Map([['alpha', probeComputer('alpha')], ['beta', probeComputer('beta')]]);
  let peer!: { id: string; revision: number };
  const f = await scriptedFixture(context => {
    const system = JSON.stringify(context.messages.filter(message => message.role === 'system'));
    const last = context.messages.findLastIndex(message => message.role === 'user');
    const input = String(context.messages[last]?.content);
    if (input.startsWith('{')) {
      assert.equal(hasTool(context, 'computer_probe'), false);
      assert.equal(hasTool(context, 'computer_begin'), false);
      return fauxAssistantMessage('Room answered without computer access.');
    }
    const results = context.messages.slice(last).filter((message): message is ToolResultMessage => message.role === 'toolResult');
    if (system.includes('BROWSER_SCOPE_PEER_61')) {
      assert.equal(hasTool(context, 'computer_probe'), false);
      const denied = results.find(result => result.toolName === 'computer_probe');
      if (!denied) return call('computer_probe');
      assert.equal(denied.isError, true);
      assert.doesNotMatch(JSON.stringify(denied), /"text":"alpha"/);
      return fauxAssistantMessage('Peer stayed inside the original tool scope.');
    }
    if (input.startsWith('ASSISTANT_REPORT ')) return call('task_submit', { summary: 'Member scope checked.', artifacts: [] });
    if (!results.some(result => result.toolName === 'assistant_assign')) return call('assistant_assign', { assistant: peer, instructions: 'Check your available tools.' });
    return fauxAssistantMessage('Waiting for the scoped peer.');
  }, {}, () => [], { browserProfiles });
  t.after(() => f.close());
  const role = await f.runtime.assistants.create({ workspace: f.workspace, name: 'Scoped browser peer',
    instructions: 'BROWSER_SCOPE_PEER_61', tools: ['computer_probe'], browserProfile: 'beta' });
  peer = { id: role.id, revision: 1 };
  const task = await f.runtime.create('Check member scope.', f.workspace, [], { browserProfile: 'alpha', collaborators: [peer] });
  assert.equal(task.collaborators?.[0]?.browserProfile, 'beta');
  const done = await until(() => f.runtime.status(task.id), row => ['completed', 'failed'].includes(row.status));
  assert.equal(done.status, 'completed');
  const companion = await f.runtime.assistants.create({ workspace: f.workspace, name: 'Room companion', instructions: 'Read the room.', tools: [] });
  const room = await f.runtime.createRoom({ workspace: f.workspace, title: 'Scoped browser room',
    members: [peer, { id: companion.id, revision: 1 }] });
  for (const origin of ['owner', 'paired'] as const) {
    await f.runtime.sendRoomMessage(room.id, { memberId: peer.id, message: origin + ' scope check', requestId: origin + '-scope' }, origin);
    const view = await until(() => f.runtime.roomDetails(room.id), row => row.active === null);
    assert.equal(view.messages.at(-1)?.text, 'Room answered without computer access.');
  }
});
