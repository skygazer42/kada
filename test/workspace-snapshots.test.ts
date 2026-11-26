import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fauxAssistantMessage, fauxToolCall, Type } from '@earendil-works/pi-ai';
import { defineExtension, defineTool } from '@earendil-works/pi-durable';
import { createClient } from '../src/client.js';
import { serve } from '../src/server.js';
import { WorkspaceSnapshots } from '../src/workspace-snapshots.js';
import { hasTool, recoveryTestTimeoutMs, scriptedFixture, startRecoveryWorker, until } from './helpers.js';

test('restore uses the displayed workspace version and preserves a reversible snapshot of the previous bytes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'kada-snapshot-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'project');
  const data = join(root, '.harness');
  await mkdir(data, { recursive: true });
  const snapshots = new WorkspaceSnapshots(data);
  const original = Buffer.from([0, 4, 128, 255]);
  await writeFile(join(root, 'sample.bin'), original);
  await writeFile(join(root, 'blank'), '');
  await writeFile(join(root, '.env'), 'LOCAL_FIXTURE=before');
  await writeFile(join(data, 'token'), 'FIXTURE_TOKEN_FILE');
  const saved = await snapshots.create(root, 'Original files');
  assert.equal(saved.files, 2);
  const changed = Buffer.from([5, 7, 222]);
  await writeFile(join(root, 'sample.bin'), changed);
  await rm(join(root, 'blank'));
  await writeFile(join(root, 'later.txt'), 'first edit');
  await writeFile(join(root, '.env'), 'LOCAL_FIXTURE=after');
  const stale = await snapshots.preview(root, saved.id);
  assert.deepEqual(stale.changes.map(change => [change.path, change.action]), [
    ['blank', 'restore'], ['later.txt', 'remove'], ['sample.bin', 'replace'],
  ]);
  await writeFile(join(root, 'later.txt'), 'final edit');
  await assert.rejects(snapshots.restore(root, saved.id, stale.version), /preview/i);
  assert.equal(await readFile(join(root, 'later.txt'), 'utf8'), 'final edit');

  const fresh = await snapshots.preview(root, saved.id);
  const report = await snapshots.restore(root, saved.id, fresh.version);
  assert.equal(report.restored, 2);
  assert.equal(report.removed, 1);
  assert.deepEqual(await readFile(join(root, 'sample.bin')), original);
  assert.equal((await stat(join(root, 'blank'))).size, 0);
  assert.equal(await readFile(join(root, '.env'), 'utf8'), 'LOCAL_FIXTURE=after');
  assert.equal(await readFile(join(data, 'token'), 'utf8'), 'FIXTURE_TOKEN_FILE');
  await assert.rejects(stat(join(root, 'later.txt')), { code: 'ENOENT' });
  assert.deepEqual(await snapshots.restore(root, saved.id, fresh.version), report);
  const reopened = new WorkspaceSnapshots(data);
  const undo = await reopened.preview(root, report.undoSnapshotId!);
  await reopened.restore(root, report.undoSnapshotId!, undo.version);
  assert.deepEqual(await readFile(join(root, 'sample.bin')), changed);
  assert.equal(await readFile(join(root, 'later.txt'), 'utf8'), 'final edit');
  await assert.rejects(stat(join(root, 'blank')), { code: 'ENOENT' });
  const repeat = await reopened.preview(root, saved.id);
  assert.notEqual(repeat.version, fresh.version);
  await reopened.restore(root, saved.id, repeat.version);
  assert.deepEqual(await readFile(join(root, 'sample.bin')), original);
});

test('a damaged blob or linked restore destination prevents writes to the whole workspace', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'kada-snapshot-preflight-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'project'), dataDir = join(directory, 'state'), outside = join(directory, 'outside');
  await Promise.all([mkdir(root), mkdir(outside)]);
  await writeFile(join(root, 'document.txt'), 'original file');
  await writeFile(join(outside, 'still-private.txt'), 'outside');
  const snapshots = new WorkspaceSnapshots(dataDir);
  const original = await snapshots.create(root, 'File');
  await rm(join(root, 'document.txt'));
  await writeFile(join(root, 'later'), 'preserve this');
  await symlink(outside, join(root, 'document.txt'), process.platform === 'win32' ? 'junction' : 'dir');
  const linked = await snapshots.preview(root, original.id);
  await assert.rejects(snapshots.restore(root, original.id, linked.version), /symlink/i);
  assert.equal(await readFile(join(root, 'later'), 'utf8'), 'preserve this');
  assert.equal(await readFile(join(outside, 'still-private.txt'), 'utf8'), 'outside');
  await rm(join(root, 'document.txt'), { recursive: true, force: true });
  const base = join(dataDir, '.kada-workspace-snapshots');
  const [bucket] = await readdir(base);
  const blobs = join(base, bucket!, 'blobs');
  const [blob] = await readdir(blobs);
  await writeFile(join(blobs, blob!), 'tampered file');
  const damaged = await snapshots.preview(root, original.id);
  await assert.rejects(snapshots.restore(root, original.id, damaged.version), /damaged/i);
  assert.equal(await readFile(join(root, 'later'), 'utf8'), 'preserve this');
  assert.equal((await snapshots.list(root)).length, 1);
});

test('the owner API refuses a restore while another task in the workspace is active', async t => {
  const waiting = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const hold = defineTool({ name: 'hold_workspace', description: 'Hold the synthetic workspace.', parameters: Type.Object({}),
    execute: async () => { waiting.resolve(); await release.promise; return { output: [] }; } });
  const f = await scriptedFixture(context => {
    if (hasTool(context, 'task_submit')) {
      return context.messages.some(message => message.role === 'toolResult' && message.toolName === 'hold_workspace')
        ? fauxAssistantMessage(fauxToolCall('task_submit', { summary: 'Original turn settled.', artifacts: [] }), { stopReason: 'toolUse' })
        : fauxAssistantMessage(fauxToolCall('hold_workspace', {}), { stopReason: 'toolUse' });
    }
    return fauxAssistantMessage('Ready.');
  }, {}, () => [defineExtension({ name: 'fixture_snapshot_hold', tools: [hold] })]);
  await f.runtime.close();
  const probe = createServer();
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const config = { ...f.settings, port };
  const server = await serve(config, { models: f.models, extensions: [defineExtension({ name: 'fixture_snapshot_hold', tools: [hold] })] });
  t.after(async () => { release.resolve(); await server.close(); await f.close(); });
  const client = createClient(config);
  const root = f.workspace;
  await writeFile(join(root, 'restore.txt'), 'saved bytes');
  const source = await server.runtime.create('Keep the original workspace.', root, [], { chat: true });
  await until(() => server.runtime.status(source.id), state => state.status === 'answered');
  const path = `/v1/tasks/${source.id}/snapshots`;
  assert.equal((await fetch(`http://127.0.0.1:${port}${path}`)).status, 401);
  const saved = await client.request<{ id: string }>(path, 'POST', { label: 'Baseline' });
  await writeFile(join(root, 'restore.txt'), 'later bytes');
  const child = join(root, 'sub');
  await mkdir(child);
  const worker = await server.runtime.create('Keep the subdirectory busy.', child);
  await waiting.promise;
  const preview = await client.request<{ version: string }>(`${path}/${saved.id}/preview`);
  await assert.rejects(client.request(`${path}/${saved.id}/restore`, 'POST', preview), /still active.*overlapping/i);
  assert.equal(await readFile(join(root, 'restore.txt'), 'utf8'), 'later bytes');
  release.resolve();
  await until(() => server.runtime.status(worker.id), state => state.status === 'completed');
  const report = await client.request<{ restored: number }>(`${path}/${saved.id}/restore`, 'POST', { version: preview.version });
  assert.equal(report.restored, 1);
  assert.equal(await readFile(join(root, 'restore.txt'), 'utf8'), 'saved bytes');
  const remote = await server.runtime.create('Remote chat', root, [], { chat: true, remote: true });
  await assert.rejects(client.request(`/v1/tasks/${remote.id}/snapshots`), /local tasks/i);
});

test('SIGKILL during restore retains an undo snapshot and retries the exact remaining effects', { timeout: recoveryTestTimeoutMs }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'kada-snapshot-recovery-')));
  const fixture = new URL('./fixtures/snapshot-restore-worker.ts', import.meta.url);
  let worker = startRecoveryWorker(fixture, 'create', directory);
  try {
    const ready = await worker.ready();
    assert.equal(await worker.stop(), 'SIGKILL');
    worker = startRecoveryWorker(fixture, 'recover', directory);
    const result = await worker.complete();
    assert.equal(result.report.snapshotId, ready.id);
    assert.equal(result.report.restored, 1);
    assert.equal(result.report.removed, 1);
    assert.equal(result.log, 'later.txt\noriginal.txt\n');
    assert.equal(result.content, 'original');
    assert.equal(result.undoContent, 'later content');
  } finally { await worker.stop(); await rm(directory, { recursive: true, force: true, maxRetries: 5 }); }
});

test('opted-in local tasks save one undo point before each execution turn', async t => {
  const id = randomUUID();
  let expected = 'before-first', observed = 0;
  const f = await scriptedFixture(async context => {
    if (!hasTool(context, 'task_submit')) {
      return fauxAssistantMessage(fauxToolCall('task_prepare', { outcome: 'Write the sample file', deliverables: ['Sample file'],
        inputs: [], scope: ['Synthetic workspace'], assumptions: [], questions: [], criteria: [{ text: 'Check the file', method: 'inspect' }] }), { stopReason: 'toolUse' });
    }
    const round = context.messages.slice(context.messages.findLastIndex(message => message.role === 'user'));
    if (round.some(message => message.role === 'toolResult' && message.toolName === 'write')) {
      return fauxAssistantMessage(fauxToolCall('task_submit', { summary: 'Sample saved.', artifacts: ['auto.txt'],
        criteria: [{ id: 1, status: 'passed', evidence: 'The sample write succeeded.' }] }), { stopReason: 'toolUse' });
    }
    const snapshots = await f.runtime.workspaceSnapshots(id);
    assert.equal(snapshots.length, ++observed);
    const before = await f.runtime.previewWorkspaceRestore(id, snapshots[0]!.id);
    assert.deepEqual(before.changes, []);
    assert.equal(await readFile(join(f.workspace, 'auto.txt'), 'utf8'), expected);
    return fauxAssistantMessage(fauxToolCall('write', { path: 'auto.txt', content: expected + '-model' }), { stopReason: 'toolUse' });
  }, { workspaceSnapshots: true });
  t.after(() => f.close());
  await writeFile(join(f.workspace, 'auto.txt'), expected);
  await f.runtime.create('Write a new sample.', f.workspace, [], { prepare: true, id });
  const brief = await until(() => f.runtime.status(id), state => state.status === 'awaiting_confirmation');
  assert.deepEqual(await f.runtime.workspaceSnapshots(id), []);
  await f.runtime.confirm(id, brief.goal!.brief!.revision, brief.briefDigest!);
  const first = await until(() => f.runtime.status(id), state => ['completed', 'failed'].includes(state.status));
  assert.equal(first.status, 'completed');
  assert.equal(observed, 1);
  assert.equal((await f.runtime.workspaceSnapshots(id)).length, 1);
  expected += '-model';
  await f.runtime.followUp(id, 'Use the second approved sample.', 'second-turn');
  const next = await until(() => f.runtime.status(id), state => ['completed', 'failed'].includes(state.status));
  assert.equal(next.status, 'completed');
  assert.equal(observed, 2);
  assert.equal((await f.runtime.workspaceSnapshots(id)).length, 2);
});

test('automatic retention keeps ten recent checkpoints, named snapshots and restore history', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'kada-snapshot-retention-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'project'), data = join(directory, 'data');
  await mkdir(root);
  const file = join(root, 'contents.txt'), snapshots = new WorkspaceSnapshots(data);
  await writeFile(file, 'manually saved');
  const manual = await snapshots.create(root, 'Keep this named copy');
  await writeFile(file, 'before original turn');
  const first = await snapshots.captureTurn(root, 'turn-fixture', 1);
  await writeFile(file, 'later edit');
  assert.deepEqual(await snapshots.captureTurn(root, 'turn-fixture', 1), first);
  const prior = await snapshots.preview(root, first.id);
  const restore = await snapshots.restore(root, first.id, prior.version);
  for (let turn = 2; turn <= 12; turn++) {
    await writeFile(file, 'before turn ' + turn);
    await snapshots.captureTurn(root, 'turn-fixture', turn);
  }
  const list = await snapshots.list(root);
  assert.equal(list.filter(item => item.automatic).length, 11);
  assert(list.some(item => item.id === first.id));
  assert(list.some(item => item.id === manual.id));
  assert(list.some(item => item.id === restore.undoSnapshotId));
  assert(!list.some(item => item.label.endsWith('turn 2')));
  assert.deepEqual(await snapshots.restore(root, first.id, prior.version), restore);
  assert.equal(await readFile(file, 'utf8'), 'before turn 12');
  const [bucket] = await readdir(join(data, '.kada-workspace-snapshots'));
  assert.equal((await readdir(join(data, '.kada-workspace-snapshots', bucket!, 'blobs'))).length, 13);
});
