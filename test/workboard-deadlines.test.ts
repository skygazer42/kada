import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WorkItems } from '../src/work-items.js';

test('the original board projects deadlines onto each saved local day without starting work', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'kada-calendar-')));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5 }));
  const workspace = join(directory, 'project');
  await mkdir(workspace);
  const items = new WorkItems(directory, { task: async () => undefined, tasks: async () => [], reopen: async () => {},
    start: async () => { throw new Error('Calendar reading must not start work.'); } });
  const add = (title: string, planning: Record<string, unknown>) => items.create({ workspace, title, objective: title, ...planning });
  const date = await add('Date only', { dueDate: '2026-12-01', timeZone: 'Pacific/Kiritimati' });
  const instant = '2026-12-01T01:30:00Z';
  const ny = await add('New York', { dueAt: instant, timeZone: 'America/New_York' });
  const tokyo = await add('Tokyo', { dueAt: instant, timeZone: 'Asia/Tokyo' });
  const open = await add('Unscheduled', {});
  const archived = await add('Archived deadline', { dueDate: '2026-12-01' });
  await items.update(archived.id, { revision: archived.revision, archived: true });
  const view = async () => Object.fromEntries((await items.board(workspace)).columns.flatMap(column => column.items).map(item => [item.id, item.dueDay]));
  assert.deepEqual(await view(), { [date.id]: '2026-12-01', [ny.id]: '2026-11-30', [tokyo.id]: '2026-12-01', [open.id]: null });
  assert.deepEqual(await items.get(ny.id), ny);
  await items.update(ny.id, { revision: ny.revision, timeZone: 'UTC' });
  assert.equal((await view())[ny.id], '2026-12-01');
});
