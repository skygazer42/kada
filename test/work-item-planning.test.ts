import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkItems, type WorkItemRun } from '../src/work-items.js';

async function fixture(t: test.TestContext) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'kada-work-planning-'))), workspace = join(directory, 'project');
  await mkdir(workspace); t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5 }));
  const runs = new Map<string, WorkItemRun & { objective: string }>();
  const open = () => new WorkItems(directory, { task: async id => runs.get(id), tasks: async () => [...runs.values()], reopen: async () => {},
    start: async (item, options) => { const run = { id: options.id, objective: item.objective, workItem: options.workItem, preparation: !options.confirmed }; runs.set(run.id, run); return run; } });
  return { directory, workspace, file: join(directory, 'work-items.json'), items: open(), open, runs };
}
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

test('legacy planning defaults and original create/update/no-op receipts survive upgrade without rewriting history', async t => {
  const f = await fixture(t);
  const first = { id: 'legacy', revision: 1, project: f.workspace, workspace: f.workspace, title: 'Original', objective: 'Original goal',
    status: 'open', archived: false, completedAt: null, createdAt: 1, updatedAt: 1 };
  const second = { ...first, revision: 2, title: 'Second', updatedAt: 2 };
  const current = { ...second, revision: 3, title: 'Later owner change', updatedAt: 3 };
  const operations = [
    { requestId: 'original-create', fingerprint: fingerprint(['create', f.workspace, first.title, first.objective, 'open', f.workspace]), result: first },
    { requestId: 'original-update', fingerprint: fingerprint(['update', first.id, 1, 'Second', undefined, undefined, undefined, f.workspace]), result: second },
    { requestId: 'original-noop', fingerprint: fingerprint(['update', first.id, 2, 'Second', undefined, undefined, undefined, f.workspace]), result: second },
  ];
  const bytes = JSON.stringify([{ ...current, operations }]); await writeFile(f.file, bytes);
  const item = await f.items.get(first.id);
  assert.equal(item.priority, 'normal'); assert.equal(item.dueDate, null); assert.equal(item.dueAt, null); assert.equal(item.timeZone, 'UTC');
  assert.equal(await readFile(f.file, 'utf8'), bytes);
  const request = (requestId: string) => ({ requestId, project: f.workspace });
  const created = await f.items.create({ workspace: f.workspace, title: first.title, objective: first.objective }, request('original-create'));
  assert.equal(created.revision, 1); assert.equal(created.priority, 'normal');
  for (const [revision, key] of [[1, 'original-update'], [2, 'original-noop']] as const) {
    const receipt = await f.items.update(first.id, { revision, title: 'Second' }, request(key));
    assert.equal(receipt.revision, 2); assert.equal(receipt.dueDate, null);
  }
  assert.equal(await readFile(f.file, 'utf8'), bytes, 'reading and replaying must leave the original bytes intact');
  await f.items.update(first.id, { revision: 3, priority: 'urgent', dueDate: '2026-12-01', timeZone: 'America/New_York' });
  await f.open().create({ workspace: f.workspace, title: first.title, objective: first.objective }, request('original-create'));
  assert.equal((await f.items.get(first.id)).priority, 'urgent', 'old replay must not undo new planning');
});

test('planning edits keep original runs and replay receipts while date and instant deadlines can be switched and cleared', async t => {
  const f = await fixture(t), input = { workspace: f.workspace, title: 'Report', objective: 'Prepare report', priority: 'high', dueDate: '2026-12-01', timeZone: 'US/Eastern' };
  const request = { requestId: 'create-planning', project: f.workspace };
  const item = await f.items.create(input, request);
  assert.equal(item.priority, 'high'); assert.equal(item.dueDate, '2026-12-01'); assert.equal(item.dueAt, null); assert.equal(item.timeZone, 'America/New_York');
  const runInput = { revision: 1, requestId: 'original-run', confirmed: true }, run = await f.items.run(item.id, runInput);
  const patch = { revision: 1, dueDate: null, dueAt: '2026-12-02T17:00:00-05:00', priority: 'urgent' };
  const updateRequest = { requestId: 'update-planning', project: f.workspace };
  const timed = await f.items.update(item.id, patch, updateRequest);
  assert.equal(timed.dueDate, null); assert.equal(timed.dueAt, '2026-12-02T22:00:00.000Z');
  const cleared = await f.items.update(item.id, { revision: 2, dueAt: null, priority: 'normal' });
  assert.equal(cleared.dueAt, null); assert.equal(cleared.priority, 'normal'); assert.equal(cleared.revision, 3);
  assert.equal((await f.items.update(item.id, { revision: 3, dueAt: null })).revision, 3);
  assert.deepEqual(await f.open().create(input, request), item);
  assert.deepEqual(await f.open().update(item.id, patch, updateRequest), timed);
  assert.deepEqual(await f.items.get(item.id), cleared);
  assert.deepEqual(await f.items.run(item.id, runInput), run); assert.equal(run.objective, 'Prepare report'); assert.equal(f.runs.size, 1);
  assert.doesNotMatch(JSON.stringify(await f.items.shared([item.id])), /operations|fingerprint|requestId/);
});

test('invalid or conflicting planning fields reject atomically including merged deadline kinds', async t => {
  const f = await fixture(t), input = { workspace: f.workspace, title: 'Report', objective: 'Prepare' };
  const item = await f.items.create({ ...input, dueDate: '2028-02-29', timeZone: 'America/New_York' });
  const bytes = await readFile(f.file, 'utf8');
  for (const fields of [{ priority: 'critical' }, { priority: null }, { dueDate: '2026-02-29' }, { dueDate: '2026-02-30' }, { dueDate: '2026-2-01' },
    { dueDate: 42 }, { dueAt: '2026-12-01T17:00:00' }, { dueAt: '2026-02-30T17:00:00Z' }, { dueAt: '2026-12-01T17:00:00+99:00' },
    { timeZone: 'Unknown/Zone' }, { timeZone: '+05:00' }, { timeZone: null }, { dueDate: '2026-12-01', dueAt: '2026-12-01T17:00:00Z' }]) {
    await assert.rejects(f.items.create({ ...input, ...fields }), { status: 400 });
    await assert.rejects(f.items.update(item.id, { revision: 1, ...fields }), { status: 400 });
    assert.equal(await readFile(f.file, 'utf8'), bytes);
  }
  await assert.rejects(f.items.update(item.id, { revision: 1, dueAt: '2026-12-01T17:00:00Z' }), { status: 400 });
  assert.equal(await readFile(f.file, 'utf8'), bytes);
});

test('concurrent planning changes keep one original revision and leave a visible conflict', async t => {
  const f = await fixture(t), item = await f.items.create({ workspace: f.workspace, title: 'Report', objective: 'Prepare' });
  const results = await Promise.allSettled([
    f.items.update(item.id, { revision: 1, priority: 'high' }), f.items.update(item.id, { revision: 1, dueDate: '2026-12-01' }),
  ]);
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
  assert.equal((results.find(row => row.status === 'rejected') as PromiseRejectedResult).reason.status, 409);
  assert.equal((await f.items.get(item.id)).revision, 2);
});

test('overdue uses the stored calendar zone across midnight and DST; completed and archived work is never overdue', async () => {
  const { workItemOverdue } = await import('../src/work-items.js');
  assert.equal(typeof workItemOverdue, 'function');
  const item = { status: 'open' as const, archived: false, dueDate: '2026-03-08', dueAt: null, timeZone: 'America/New_York' };
  assert.equal(workItemOverdue(item, Date.parse('2026-03-09T03:59:59Z')), false);
  assert.equal(workItemOverdue(item, Date.parse('2026-03-09T04:00:00Z')), true);
  const fall = { ...item, dueDate: '2026-11-01' };
  assert.equal(workItemOverdue(fall, Date.parse('2026-11-02T04:59:59Z')), false);
  assert.equal(workItemOverdue(fall, Date.parse('2026-11-02T05:00:00Z')), true);
  const timed = { ...item, dueDate: null, dueAt: '2026-11-01T06:30:00.000Z' };
  assert.equal(workItemOverdue(timed, Date.parse(timed.dueAt)), false);
  assert.equal(workItemOverdue(timed, Date.parse(timed.dueAt) + 1), true);
  assert.equal(workItemOverdue({ ...item, status: 'done' }, Date.parse('2030-01-01')), false);
  assert.equal(workItemOverdue({ ...item, archived: true }, Date.parse('2030-01-01')), false);
  assert.equal(workItemOverdue({ ...item, dueDate: null }, Date.parse('2030-01-01')), false);
});
