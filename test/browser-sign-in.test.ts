import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { promisify } from 'node:util';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import type { ToolExecutionApi } from '@earendil-works/pi-durable';
import { ChatSession } from '../src/chat.js';
import { createClient, type TaskStatus } from '../src/client.js';
import { ComputerBridge } from '../src/computer.js';
import { LocalRuntime } from '../src/runtime.js';
import { serve } from '../src/server.js';
import { VERSION } from '../src/version.js';
import { hasTool, scriptedFixture, until } from './helpers.js';

const driver = {
  command: process.execPath,
  args: ['--import', 'tsx', fileURLToPath(new URL('./fixtures/computer-server.ts', import.meta.url)), '--browser'],
  tools: ['agent_browser_snapshot', 'agent_browser_click'], observationTools: ['agent_browser_snapshot'],
};
const snapshot = 'computer_0_agent_browser_snapshot';
const call = (name: string, args = {}) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' });

test('the terminal cannot send a named task or takeover to a daemon without browser profile support', async t => {
  const fixture = await scriptedFixture(() => assert.fail('A legacy daemon must not receive the task.'));
  let mutations = 0;
  const daemon = createHttpServer((request, response) => {
    if (request.method !== 'GET') mutations++;
    response.setHeader('Content-Type', 'application/json');
    response.end(request.url === '/health' ? JSON.stringify({ status: 'ok', version: VERSION, capabilities: ['ordinary-chat'] }) : '[]');
  });
  t.after(async () => {
    daemon.closeAllConnections();
    await new Promise<void>(resolve => daemon.close(() => resolve()));
    await fixture.close();
  });
  await new Promise<void>(resolve => daemon.listen(0, '127.0.0.1', resolve));
  const config = join(fixture.directory, 'legacy-daemon.json');
  await writeFile(join(fixture.settings.dataDir, 'token'), 'fixture-token');
  await writeFile(config, JSON.stringify({ ...fixture.settings, port: (daemon.address() as { port: number }).port }));
  const execute = promisify(execFile);
  for (const command of [['run', 'Use the named fixture.', '--detach'], ['computer', 'takeover']]) {
    await assert.rejects(execute(process.execPath,
      ['--import', 'tsx', 'src/cli.ts', ...command, '--browser-profile', 'alpha', '--config', config]), /支持浏览器配置/);
  }
  assert.equal(mutations, 0);
});

test('two selected browser profiles keep independent takeovers and resume their original tasks after restart', { timeout: 60_000 }, async t => {
  const f = await scriptedFixture(context => {
    const profile = context.messages.some(message => message.role === 'user' && String(message.content).includes('Profile alpha')) ? 'alpha' : 'beta';
    const after = context.messages.findLastIndex(message => message.role === 'user' && String(message.content).includes('The user finished the requested browser step'));
    const results = context.messages.slice(after + 1).filter(message => message.role === 'toolResult');
    if (!results.some(result => result.toolName === 'computer_begin')) return call('computer_begin');
    const observed = results.find(result => result.toolName === snapshot);
    if (!observed) return call(snapshot, { interactive: true });
    assert.match(JSON.stringify(observed), new RegExp('fixture session ' + profile));
    if (after < 0) return call('computer_request_sign_in', { step: 'verification' });
    return call('task_submit', { summary: 'Reobserved the original selected browser.', artifacts: [] });
  });
  await f.runtime.close();
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>(resolve => listener.close(() => resolve()));
  const named = (id: string) => ({ ...driver, args: [...driver.args, '--named'], env: { AGENT_BROWSER_SESSION: id } });
  const config = { ...f.settings, port, browserProfiles: { alpha: named('alpha'), beta: named('beta') } };
  let service = await serve(config, { models: f.models });
  t.after(async () => { await service.close(); await f.close(); });
  const client = createClient(config);
  const create = (browserProfile?: string) => client.request<TaskStatus>('/v1/tasks', 'POST', {
    objective: 'Profile ' + browserProfile + ' needs verification.', workspace: f.workspace, confirmed: true, browserProfile,
  });
  const control = (profile: string) => client.request<{ connected: boolean; mode: string }>('/v1/computer?profile=' + profile);
  assert((await control('alpha')).connected);
  assert((await control('beta')).connected);
  await assert.rejects(create('unknown'), /profile/i);
  const [alpha, beta] = await Promise.all([create('alpha'), create('beta')]);
  const wait = (id: string) => until(() => service.runtime.status(id), status => status.status === 'waiting_user' && status.submission?.status === 'done');
  const [a, b] = await Promise.all([wait(alpha.id), wait(beta.id)]);
  const action = (task: typeof a, verb: string) => client.request('/v1/tasks/' + task.id + '/browser-sign-in/' + task.userQuestion!.id, 'POST', { action: verb });
  await action(a, 'takeover');
  await action(b, 'takeover');
  assert.equal((await control('alpha')).mode, 'user');
  assert.equal((await control('beta')).mode, 'user');
  await service.close();
  service = await serve({ ...config, browserProfiles: { renamed: named('alpha'), beta: named('beta') } }, { models: f.models });
  assert.equal((await control('renamed')).mode, 'user');
  assert.equal((await control('beta')).mode, 'user');
  await assert.rejects(action(a, 'continue'), /original browser driver/i);
  await service.close();
  service = await serve({ ...config, browserProfiles: { ...config.browserProfiles, alpha: named('replacement') } }, { models: f.models });
  assert.equal((await control('alpha')).mode, 'agent');
  assert.equal((await control('beta')).mode, 'user');
  await assert.rejects(action(a, 'continue'), /original browser driver/i);
  await service.close();
  service = await serve(config, { models: f.models });
  assert.equal((await control('alpha')).mode, 'user');
  assert.equal((await control('beta')).mode, 'user');
  await action(a, 'continue');
  await until(() => service.runtime.status(alpha.id), status => status.status === 'completed');
  assert.equal((await control('alpha')).mode, 'agent');
  assert.equal((await control('beta')).mode, 'user');
  await action(b, 'continue');
  await until(() => service.runtime.status(beta.id), status => status.status === 'completed');
  assert.equal((await control('beta')).mode, 'agent');
  await service.close();
  await assert.rejects(serve({ ...config, browserProfiles: { alpha: named('alpha'), duplicate: named('alpha') } }, { models: f.models }),
    /same browser session|duplicate session/i);
});

test('new browser tasks keep their original synthetic driver through reconnect and restart', async t => {
  const first = {...driver,env:{AGENT_BROWSER_SESSION:'fixture-a'}};
  const second = {...driver,env:{AGENT_BROWSER_SESSION:'fixture-b'}};
  let bridge = new ComputerBridge();
  await bridge.connect(first);
  let mode: 'initial' | 'replaced' | 'restored' = 'initial';
  const available: boolean[] = [];
  const f = await scriptedFixture(context => {
    available.push(hasTool(context,'computer_begin'));
    return mode === 'restored' ? call('task_submit',{summary:'Original driver restored.',artifacts:[]})
      : call('task_blocked',{reason:'Waiting for the owner.',question:'Continue this browser task?'});
  });
  await f.runtime.close();
  let runtime = new LocalRuntime(f.settings,{models:f.models,computer:bridge});
  t.after(async () => { await runtime.close(); await bridge.close(); await f.close(); });
  const task = await runtime.create('Use the original synthetic browser session.',f.workspace);
  const wait = (requestId: string, status: string) => until(() => runtime.status(task.id),
    row => row.status===status && row.submission?.requestId===requestId && row.submission?.status==='done');
  await wait('initial','waiting_user');
  const original = bridge.browserKey()!;
  const begin = bridge.forTask(task.id,true,original).tools!.find(tool => tool.name === 'computer_begin')!;
  await bridge.connect(second);
  await assert.rejects(begin.execute({},{} as ToolExecutionApi,BACKGROUND_CONTEXT),/original browser driver/i);
  assert.equal(bridge.status().owner,null);

  async function restart(config: typeof first) {
    await runtime.close();
    await bridge.close();
    bridge = new ComputerBridge();
    await bridge.connect(config);
    runtime = new LocalRuntime(f.settings,{models:f.models,computer:bridge});
    await runtime.recover();
  }
  await restart(second);
  mode='replaced';
  await runtime.followUp(task.id,'Check the current browser.','other-driver');
  await wait('user:other-driver','waiting_user');
  assert.equal(available.at(-1),false);
  await restart(first);
  mode='restored';
  await runtime.followUp(task.id,'Continue with the original browser.','original-driver');
  await wait('user:original-driver','completed');
  assert.equal(available.at(-1),true);
});

test('a browser sign-in request restores the user takeover after restart and resumes the original task once', async t => {
  let completedTurns = 0;
  const f = await scriptedFixture(context => {
    assert(hasTool(context, 'computer_request_sign_in'));
    if (context.messages.some(message => message.role === 'user' && String(message.content).includes('The user declined the requested browser step'))) {
      return call('task_submit', { summary: 'The user declined sign-in.', artifacts: [] });
    }
    const after = context.messages.findLastIndex(message => message.role === 'user' && String(message.content).includes('The user finished the requested browser step'));
    const results = context.messages.slice(after + 1).filter(message => message.role === 'toolResult');
    if (!results.some(result => result.toolName === 'computer_begin')) return call('computer_begin');
    if (!results.some(result => result.toolName === snapshot)) return call(snapshot, { interactive: true });
    if (after < 0) return call('computer_request_sign_in', { step: 'verification' });
    completedTurns++;
    return call('task_submit', { summary: 'The original browser task resumed.', artifacts: [] });
  });
  await f.runtime.close();
  const socket = createServer();
  await new Promise<void>(done => socket.listen(0, '127.0.0.1', done));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>(done => socket.close(() => done()));
  const config = { ...f.settings, port };
  const client = createClient(config);
  let bridge = new ComputerBridge();
  await bridge.connect(driver);
  let service = await serve(config, { models: f.models, computer: bridge });
  t.after(async () => { await service.close(); await bridge.close(); await f.close(); });

  const task = await service.runtime.create('Use the already open local browser fixture.', f.workspace);
  const status = () => client.request<TaskStatus>('/v1/tasks/' + task.id);
  const waiting = await until(status, view => view.status === 'waiting_user' && view.submission?.status === 'done' || view.status === 'failed' || view.status === 'blocked');
  assert.equal(waiting.status, 'waiting_user');
  const question = waiting.userQuestion!;
  assert.equal(question.browserSignIn, 'verification');
  const request = (action: string, questionId = question.id) => client.request(`/v1/tasks/${task.id}/browser-sign-in/${questionId}`, 'POST', { action });
  await assert.rejects(service.runtime.followUp(task.id, 'Here is a credential in ordinary chat.', 'wrong-input'), /browser/i);
  await assert.rejects(client.request(`/v1/tasks/${task.id}/questions/${question.id}/answer`, 'POST', { requestId: 'ordinary-answer', answer: 'Pretend it is finished' }), /browser/i);
  await assert.rejects(request('continue'), /take over/i);
  await assert.rejects(request('takeover', '0'), /not found|changed/i);
  const unauthenticated = await fetch(`http://127.0.0.1:${port}/v1/tasks/${task.id}/browser-sign-in/${question.id}`, { method: 'POST', body: JSON.stringify({ action: 'takeover' }) });
  assert.equal(unauthenticated.status, 401);
  const terminal: string[] = [];
  const chat = new ChatSession(client, event => terminal.push(event.text));
  await chat.attach(task.id);
  assert(terminal.some(line => line.includes(`/sign-in ${question.id}`)));
  await chat.handle(`/sign-in ${question.id}`);
  await request('takeover');
  assert.equal(bridge.status().mode, 'user');

  await service.close();
  await bridge.close();
  bridge = new ComputerBridge();
  await bridge.connect(driver);
  service = await serve(config, { models: f.models, computer: bridge });
  assert.equal((await status()).userQuestion?.id, question.id);
  assert.equal(bridge.status().mode, 'user');
  await service.runtime.resume(task.id);
  assert.equal((await status()).userQuestion?.id, question.id, 'renewing the task budget keeps the original browser question');
  assert.equal(bridge.status().mode, 'user');
  const action = bridge.forTask('another-task').tools!.find(tool => tool.name === 'computer_begin')!;
  await assert.rejects(action.execute({}, {} as ToolExecutionApi, BACKGROUND_CONTEXT), /user has desktop control/i);
  await bridge.connect({ ...driver, args: [...driver.args, '--different-session'] });
  await assert.rejects(request('continue'), /original browser driver/i);
  await bridge.connect(driver);

  service.runtime['dispatchOutbox'] = async () => { throw new Error('Simulated interruption after saving sign-in answer.'); };
  await assert.rejects(request('continue'), /interruption after saving/i);
  assert.equal(bridge.status().mode, 'user');
  await service.close();
  await bridge.close();
  bridge = new ComputerBridge();
  await bridge.connect({ ...driver, args: [...driver.args, '--different-session'] });
  service = await serve(config, { models: f.models, computer: bridge });
  const paused = await status();
  assert.equal(paused.status, 'paused');
  assert.match(paused.initializationError ?? '', /original browser driver/i);
  assert.equal(bridge.status().mode, 'user');
  await service.close();
  await bridge.close();
  bridge = new ComputerBridge();
  await bridge.connect(driver);
  service = await serve(config, { models: f.models, computer: bridge });
  await service.runtime.resume(task.id);
  const done = await until(status, view => view.status === 'completed');
  assert.equal(bridge.status().mode, 'agent');
  assert.equal(done.messages.filter(message => message.role === 'user' && String(message.content).includes('The user finished the requested browser step')).length, 1);
  assert.doesNotMatch(JSON.stringify(done.messages), /credential in ordinary chat/);
  await request('continue');
  await assert.rejects(request('decline'), /different/i);
  assert.equal(completedTurns, 1);

  const next = await service.runtime.create('Try another task in the same local browser.', f.workspace);
  const declined = await until(() => service.runtime.status(next.id), view => view.status === 'waiting_user' && view.submission?.status === 'done');
  await client.request('/v1/computer/takeover', 'POST', {});
  await client.request(`/v1/tasks/${next.id}/browser-sign-in/${declined.userQuestion!.id}`, 'POST', { action: 'decline' });
  await until(() => service.runtime.status(next.id), view => view.status === 'completed');
  assert.equal(bridge.status().mode, 'user', 'a decline cannot end an unbound manual takeover');
  await client.request('/v1/computer/return', 'POST', {});
  assert.equal(bridge.status().mode, 'agent');
});
