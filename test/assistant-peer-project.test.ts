import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { isAbsolute, join, relative } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fauxAssistantMessage, fauxToolCall, type ToolResultMessage } from '@earendil-works/pi-ai';
import { createClient } from '../src/client.js';
import { serve } from '../src/server.js';
import { hasTool, scriptedFixture, until } from './helpers.js';

const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' });
const within = (root: string, path: string) => {
  const rel = relative(root, path);
  return Boolean(rel && !isAbsolute(rel) && !rel.startsWith('..'));
};

test('an owner authorizes a peer project through the CLI and receives its original output after restart', { timeout: 60_000 }, async t => {
  const inputBytes = Buffer.from([0, 1, 255, 42]);
  let source!: string, peer!: string, selected!: { id: string; revision: number }, peerRequests = 0;
  const f = await scriptedFixture(context => {
    const latest = String(context.messages.findLast(message => message.role === 'user')?.content);
    const round = context.messages.slice(context.messages.findLastIndex(message => message.role === 'user'));
    const results = round.filter((message): message is ToolResultMessage => message.role === 'toolResult');
    const result = (name: string) => results.find(message => message.toolName === name);
    const system = JSON.stringify(context.messages.filter(message => message.role === 'system'));
    if (system.includes('KADA_TEST_REMOTE_PROJECT_REVIEWER')) {
      peerRequests++;
      assert.equal(hasTool(context, 'bash'), false);
      assert.equal(hasTool(context, 'read'), true);
      assert.doesNotMatch(system, /After compaction or restart, read task_status/);
      assert(!system.includes(JSON.stringify(source).slice(1, -1)));
      if (latest.startsWith('Rework of original assistant work')) return fauxAssistantMessage('Rechecked the original copy.');
      if (latest.startsWith('ASSISTANT_ANSWER ')) {
        assert.match(latest, /Use the sealed copy/);
        const writes = results.filter(message => message.toolName === 'write');
        if (!writes.length) return call('write', { path: join(source, 'out-of-scope.txt'), content: 'denied' });
        assert.equal(writes[0]?.isError, true);
        if (writes.length === 1) return call('write', { path: 'review.txt', content: 'Verified sealed data.' });
        assert.equal(writes[1]?.isError, false);
        if (!result('assistant_attach')) return call('assistant_attach', { files: ['review.txt'] });
        assert.equal(result('assistant_attach')!.isError, false);
        return fauxAssistantMessage('The exact project review is attached.');
      }
      const fileData = JSON.parse(latest.split('ASSISTANT_INPUT_FILES ')[1]!);
      assert.equal(fileData[0].sourcePath, undefined);
      assert(within(peer, fileData[0].path));
      const reads = results.filter(message => message.toolName === 'read');
      if (!reads.length) return call('read', { path: 'peer-data.txt' });
      assert.equal(reads[0]?.isError, false);
      assert.match(JSON.stringify(reads[0]), /PEER_PROJECT_FIXTURE/);
      if (reads.length === 1) return call('read', { path: join(source, 'private-in-source.txt') });
      assert.equal(reads[1]?.isError, true);
      assert.doesNotMatch(JSON.stringify(reads[1]), /SOURCE_PRIVATE_FIXTURE/);
      return call('assistant_ask', { question: 'Which evidence?', options: ['Use the sealed copy', 'Stop review'] });
    }
    if (hasTool(context, 'task_prepare')) {
      assert(!hasTool(context, 'assistant_assign'));
      return call('task_prepare', { outcome: 'Review the sealed file', deliverables: ['Peer review'], inputs: [],
        scope: ['Explicitly selected projects'], assumptions: [], questions: [], criteria: [{ text: 'Read the returned project evidence', method: 'inspect' }] });
    }
    if (latest.startsWith('ASSISTANT_QUESTION ')) return fauxAssistantMessage('Waiting for the owner.');
    if (latest.startsWith('ASSISTANT_REPORT ')) {
      const receipt = JSON.parse(latest.slice('ASSISTANT_REPORT '.length));
      if (receipt.reworkOf) return call('task_submit', { summary: 'Original review and rework verified.', artifacts: [],
        criteria: [{ id: 1, status: 'passed', evidence: 'The original assistant receipt returned its fixed file.' }] });
      assert(within(source, receipt.outputs[0].path));
      assert.equal(receipt.outputs[0].sourcePath, undefined);
      if (!result('assistant_rework')) return call('assistant_rework', { id: receipt.id, instructions: 'Recheck the sealed copy.' });
      assert.equal(result('assistant_rework')!.isError, false);
      return fauxAssistantMessage('Waiting for the rework.');
    }
    if (!result('assistant_directory')) return call('assistant_directory', {});
    assert.match(JSON.stringify(result('assistant_directory')), new RegExp(selected.id));
    if (!result('assistant_assign')) return call('assistant_assign', { assistant: selected, instructions: 'Review the provided evidence.', files: ['sealed.bin'] });
    assert.equal(result('assistant_assign')!.isError, false);
    return fauxAssistantMessage('Assigned to the chosen project.');
  });
  source = f.workspace;
  peer = join(f.directory, 'peer-workspace');
  const unrelated = join(f.directory, 'unrelated');
  await mkdir(peer);
  await mkdir(unrelated);
  await writeFile(join(source, 'sealed.bin'), inputBytes);
  await writeFile(join(source, 'private-in-source.txt'), 'SOURCE_PRIVATE_FIXTURE');
  await writeFile(join(peer, 'peer-data.txt'), 'PEER_PROJECT_FIXTURE');
  await f.runtime.close();
  const socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const config = { ...f.settings, port, maxDurationMs: 60_000 };
  let daemon = await serve(config, { models: f.models });
  t.after(async () => { await daemon.close(); await f.close(); });
  const client = createClient(config);
  const { id, revision } = await client.request<typeof selected>('/v1/assistants', 'POST', {
    workspace: peer, name: 'Peer reviewer', instructions: 'KADA_TEST_REMOTE_PROJECT_REVIEWER',
    tools: ['read', 'write', 'bash', 'assistant_ask', 'assistant_attach'],
  });
  selected = { id, revision };
  await assert.rejects(daemon.runtime.create('No target grant', source, [], { collaborators: [selected] }), { status: 404 });
  await assert.rejects(daemon.runtime.create('Wrong project', source, [], { collaborators: [{ ...selected, workspace: unrelated }] }), { status: 404 });
  await assert.rejects(daemon.runtime.create('Missing project', source, [], { collaborators: [{ ...selected, workspace: join(f.directory, 'missing') }] }), { status: 400 });
  const configFile = join(f.directory, 'cross-project-config.json');
  await writeFile(configFile, JSON.stringify(config));
  const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'run', 'Review from the selected project',
    '--workspace', source, '--collaborator', id + '@' + revision + '=' + peer, '--detach', '--config', configFile]);
  const taskId = /^Task: ([a-f0-9-]+)$/m.exec(stdout)?.[1];
  assert(taskId);
  const taskPath = '/v1/tasks/' + taskId;
  const prepared = await until(() => daemon.runtime.status(taskId), state => state.status === 'awaiting_confirmation');
  assert.equal(peerRequests, 0);
  await client.request(taskPath + '/confirm', 'POST', { revision: prepared.goal!.brief!.revision, digest: prepared.briefDigest });
  const waiting = await until(() => daemon.runtime.status(taskId), state => state.status === 'waiting_assistant');
  const [work] = waiting.assistantWork;
  assert(work);
  assert(within(peer, work.files[0]!.path));
  assert.deepEqual(await readFile(work.files[0]!.path), inputBytes);
  await writeFile(join(source, 'sealed.bin'), 'later source');
  await daemon.close();
  daemon = await serve(config, { models: f.models });
  const question = work.questions[0]!;
  assert.equal((await daemon.runtime.status(taskId)).assistantWork[0]!.questions[0]!.id, question.id);
  await client.request(taskPath + '/assistant-work/' + work.id + '/questions/' + question.id + '/answer', 'POST',
    { requestId: 'answer-cross-project', answer: 'Use the sealed copy' });
  const done = await until(() => daemon.runtime.status(taskId), state => ['completed', 'failed', 'needs_attention'].includes(state.status));
  assert.equal(done.status, 'completed');
  assert.equal(done.deadlineAt, waiting.deadlineAt);
  assert.equal(done.assistantWork.length, 2);
  assert(done.budget.totalTokens > done.assistantWork[0]!.usage.totalTokens);
  const original = done.assistantWork.find(item => item.id === work.id)!;
  const rework = done.assistantWork.find(item => item.reworkOf === work.id)!;
  assert.equal(rework.conversationId, original.conversationId);
  assert.deepEqual(await readFile(rework.files[0]!.path), inputBytes);
  const returned = original.outputs[0]!;
  assert(within(source, returned.path));
  assert.equal(await readFile(returned.path, 'utf8'), 'Verified sealed data.');
  assert.equal(await readFile(join(peer, 'review.txt'), 'utf8'), 'Verified sealed data.');
  await assert.rejects(readFile(join(source, 'out-of-scope.txt')), { code: 'ENOENT' });
});

test('each hop uses its own workspace and sends only fixed file copies to the original requester', { timeout: 40_000 }, async t => {
  let first!: string, second!: string, firstRef!: { id: string; revision: number }, secondRef!: typeof firstRef;
  const f = await scriptedFixture(context => {
    const latest = String(context.messages.findLast(message => message.role === 'user')?.content);
    const role = JSON.stringify(context.messages.filter(message => message.role === 'system'));
    const round = context.messages.slice(context.messages.findLastIndex(message => message.role === 'user'));
    const results = round.filter((message): message is ToolResultMessage => message.role === 'toolResult');
    if (role.includes('SECOND_PROJECT_STAGE_641')) {
      const reads = results.filter(item => item.toolName === 'read');
      if (!reads.length) return call('read', { path: 'linked-project/handoff.txt' });
      assert.equal(reads[0]!.isError, true);
      const [file] = JSON.parse(latest.split('ASSISTANT_INPUT_FILES ')[1]!);
      assert(within(second, file.path));
      assert.equal(file.sourcePath, undefined);
      if (reads.length === 1) return call('read', { path: file.path });
      assert.equal(reads[1]!.isError, false);
      assert.match(JSON.stringify(reads[1]), /HANDOFF_FIXTURE_52/);
      if (!results.some(item => item.toolName === 'assistant_attach')) return call('assistant_attach', { files: ['second-result.txt'] });
      return fauxAssistantMessage('Second project delivered its result.');
    }
    if (role.includes('FIRST_PROJECT_STAGE_713')) {
      if (!latest.startsWith('ASSISTANT_REPORT ')) {
        if (!results.some(item => item.toolName === 'assistant_assign')) {
          return call('assistant_assign', { assistant: secondRef, instructions: 'Read the incoming copy.', files: ['handoff.txt'] });
        }
        assert.equal(results.find(item => item.toolName === 'assistant_assign')!.isError, false);
        return fauxAssistantMessage('Waiting for the second project.');
      }
      const receipt = JSON.parse(latest.slice('ASSISTANT_REPORT '.length));
      const [returned] = receipt.outputs;
      assert(within(first, returned.path));
      if (!results.some(item => item.toolName === 'read')) return call('read', { path: returned.path });
      assert.match(JSON.stringify(results.find(item => item.toolName === 'read')), /SECOND_PROJECT_RESULT_19/);
      if (!results.some(item => item.toolName === 'assistant_attach')) return call('assistant_attach', { files: [returned.path] });
      assert.equal(results.find(item => item.toolName === 'assistant_attach')!.isError, false);
      return fauxAssistantMessage('First project passed the second result to its requester.');
    }
    if (latest.startsWith('ASSISTANT_REPORT ')) return call('task_submit', { summary: 'Verified the two project steps.', artifacts: [] });
    if (!results.some(item => item.toolName === 'assistant_assign')) return call('assistant_assign', { assistant: firstRef, instructions: 'Ask the second project to check your input.' });
    assert.equal(results.find(item => item.toolName === 'assistant_assign')!.isError, false);
    return fauxAssistantMessage('Waiting for the first project.');
  });
  t.after(() => f.close());
  first = join(f.directory, 'first-project');
  second = join(f.directory, 'second-project');
  await mkdir(first);
  await mkdir(second);
  await symlink(first, join(second, 'linked-project'), process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(join(first, 'handoff.txt'), 'HANDOFF_FIXTURE_52');
  await writeFile(join(second, 'second-result.txt'), 'SECOND_PROJECT_RESULT_19');
  const select = async (workspace: string, name: string, instructions: string, tools: string[]) => {
    const { id, revision } = await f.runtime.assistants.create({ workspace, name, instructions, tools });
    return { id, revision };
  };
  firstRef = await select(first, 'First stage', 'FIRST_PROJECT_STAGE_713', ['read', 'assistant_assign', 'assistant_attach']);
  secondRef = await select(second, 'Second stage', 'SECOND_PROJECT_STAGE_641', ['read', 'assistant_attach']);
  const task = await f.runtime.create('Verify the two project steps.', f.workspace, [], {
    collaborators: [{ ...firstRef, workspace: first }, { ...secondRef, workspace: second }],
  });
  const done = await until(() => f.runtime.status(task.id), state => ['completed', 'failed', 'needs_attention'].includes(state.status));
  assert.equal(done.status, 'completed');
  const outer = done.assistantWork.find(item => item.assistant.id === firstRef.id)!;
  const inner = done.assistantWork.find(item => item.assistant.id === secondRef.id)!;
  assert.equal(inner.parentId, outer.id);
  assert(within(second, inner.files[0]!.path));
  assert(within(first, inner.outputs[0]!.path));
  assert(within(f.workspace, outer.outputs[0]!.path));
  assert.equal(await readFile(outer.outputs[0]!.path, 'utf8'), 'SECOND_PROJECT_RESULT_19');
});
