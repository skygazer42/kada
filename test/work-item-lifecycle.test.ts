import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkItems, type WorkItemRun } from '../src/work-items.js';

async function fixture(t: test.TestContext) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'kada-work-lifecycle-')));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 3 }));
  const workspace = join(directory, 'project'), other = join(directory, 'other');
  await mkdir(join(workspace, '.git'), { recursive: true }); await mkdir(other);
  const runs = new Map<string, WorkItemRun & { objective: string }>();
  const open = () => new WorkItems(directory, {
    task: async (id: string) => runs.get(id), tasks: async () => [...runs.values()], reopen: async () => {},
    start: async (item, options) => {
      const run = { id: options.id, objective: item.objective, workItem: options.workItem, preparation: !options.confirmed };
      runs.set(run.id, run); return run;
    },
  });
  return { directory, workspace, other, path: join(directory, 'work-items.json'), items: open(), open, runs };
}

test('legacy work items project lifecycle defaults without rewriting history; completion, reopening and archiving preserve original runs', async t => {
  const f = await fixture(t);
  const legacy = { id: 'legacy', project: f.workspace, workspace: f.workspace, title: 'Original', objective: 'Original goal', revision: 1, createdAt: 1, updatedAt: 1 };
  const bytes = JSON.stringify([legacy]); await writeFile(f.path, bytes);
  const original = await f.items.get(legacy.id);
  assert.equal(original.status, 'open'); assert.equal(original.archived, false); assert.equal(original.completedAt, null);
  assert.equal(await readFile(f.path, 'utf8'), bytes);
  const request = { revision: 1, requestId: 'original-run', confirmed: true };
  const run = await f.items.run(legacy.id, request);
  const done = await f.items.update(legacy.id, { revision: 1, status: 'done' });
  assert.equal(done.revision, 2); assert.equal(typeof done.completedAt, 'number');
  const renamed = await f.items.update(legacy.id, { revision: 2, title: 'Already done' });
  assert.equal(renamed.completedAt, done.completedAt);
  assert.deepEqual(await f.items.run(legacy.id, request), run);
  await assert.rejects(f.items.run(legacy.id, { revision: 3, requestId: 'new-run' }), { status: 409 });
  const reopened = await f.items.update(legacy.id, { revision: 3, status: 'parked' });
  assert.equal(reopened.completedAt, null);
  const archived = await f.items.update(legacy.id, { revision: 4, archived: true });
  assert.equal(archived.status, 'parked'); assert.equal(archived.archived, true);
  await assert.rejects(f.items.run(legacy.id, { revision: 5, requestId: 'archived-run' }), { status: 409 });
  assert.equal(f.runs.size, 1); assert.equal((await f.items.runs(legacy.id))[0].objective, 'Original goal');
  assert.deepEqual(await f.open().get(legacy.id), archived);
  assert.equal((await f.items.list(f.workspace))[0].archived, true, 'owner list retains archived records');
});

test('work item mutations atomically retain original request receipts across later edits, no-ops and reopening', async t => {
  const f = await fixture(t);
  const request = { requestId: 'chat-first-create', project: f.workspace };
  const input = { workspace: f.workspace, title: 'Report', objective: 'Prepare the report' };
  const [first, replay] = await Promise.all([f.items.create(input, request), f.items.create(input, request)]);
  assert.deepEqual(replay, first); assert.equal((await f.items.list(f.workspace)).length, 1);
  const update = { revision: 1, title: 'Updated report', status: 'parked' };
  const editRequest = { requestId: 'chat-edit', project: f.workspace };
  const edited = await f.items.update(first.id, update, editRequest);
  const noOp = { revision: edited.revision, title: edited.title };
  const noOpRequest = { requestId: 'chat-no-op', project: f.workspace };
  assert.deepEqual(await f.items.update(first.id, noOp, noOpRequest), edited);
  const archived = await f.items.update(first.id, { revision: 2, archived: true, status: 'done' });
  assert.deepEqual(await f.open().create(input, request), first);
  assert.deepEqual(await f.open().update(first.id, update, editRequest), edited);
  assert.deepEqual(await f.open().update(first.id, noOp, noOpRequest), edited);
  assert.deepEqual(await f.items.get(first.id), archived);
  await assert.rejects(f.items.create({ ...input, title: 'Different' }, request), { status: 409 });
  await assert.rejects(f.items.update(first.id, { ...update, title: 'Different' }, editRequest), { status: 409 });
  await assert.rejects(f.items.update(first.id, update, { ...editRequest, project: f.other }), { status: 409 });
  assert.doesNotMatch(JSON.stringify([await f.items.get(first.id), await f.items.list(f.workspace), await f.items.shared([first.id])]), /operations|fingerprint|requestId/);
  const disk = JSON.parse(await readFile(f.path, 'utf8'));
  assert.equal(disk[0].operations.length, 3);
});

test('work item validation and in-queue project/revision checks reject stale or foreign mutations', async t => {
  const f = await fixture(t);
  const item = await f.items.create({ workspace: f.workspace, title: 'Report', objective: 'Prepare', status: 'parked' });
  const results = await Promise.allSettled([
    f.items.update(item.id, { revision: 1, status: 'done' }, { requestId: 'first', project: f.workspace }),
    f.items.update(item.id, { revision: 1, title: 'Late' }, { requestId: 'second', project: f.workspace }),
  ]);
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
  const rejected = results.find(row => row.status === 'rejected')!; assert.equal(rejected.reason.status, 409);
  await assert.rejects(f.items.update(item.id, { revision: 2, title: 'Foreign' }, { requestId: 'foreign', project: f.other }), { status: 404 });
  for (const input of [{ status: 'running' }, { archived: 'true' }, { completedAt: 2 }, {}, { title: '' }]) await assert.rejects(f.items.update(item.id, { revision: 2, ...input }), { status: 400 });
  await assert.rejects(f.items.create({ workspace: f.workspace, title: 'Bad', objective: 'Bad', status: 'running' }), { status: 400 });
  await assert.rejects(f.items.create({ workspace: f.other, title: 'Foreign', objective: 'Bad' }, { requestId: 'cross-create', project: f.workspace }), { status: 409 });
  await assert.rejects(f.items.create({ workspace: f.workspace, title: 'Bad', objective: 'Bad' }, { requestId: '../bad', project: f.workspace }), { status: 400 });
});
