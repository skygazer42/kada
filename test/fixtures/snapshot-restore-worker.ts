import assert from 'node:assert/strict';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { WorkspaceSnapshots } from '../../src/workspace-snapshots.js';

const [phase, directory] = process.argv.slice(2) as [string, string];
const root = join(directory, 'workspace'), app = join(directory, 'app'), log = join(directory, 'restore.log');
const input = join(directory, 'original-preview.json');
const snapshots = new WorkspaceSnapshots(app);
const apply = snapshots['applyFile'].bind(snapshots);
snapshots['applyFile'] = async (scope, change, version) => {
  await apply(scope, change, version);
  await appendFile(log, change.path + '\n');
  if (phase === 'create') {
    const { id } = JSON.parse(await readFile(input, 'utf8'));
    console.log(JSON.stringify({ type: 'ready', id }));
    await setTimeout(60_000);
  }
};

if (phase === 'create') {
  await mkdir(root);
  await writeFile(join(root, 'original.txt'), 'original');
  const saved = await snapshots.create(root, 'Original workspace');
  await writeFile(join(root, 'original.txt'), 'modified');
  await writeFile(join(root, 'later.txt'), 'later content');
  const preview = await snapshots.preview(root, saved.id);
  await writeFile(input, JSON.stringify({ id: saved.id, version: preview.version }));
  await snapshots.restore(root, saved.id, preview.version);
  throw new Error('The fixture should be interrupted after the first restore effect.');
}

const { id, version } = JSON.parse(await readFile(input, 'utf8'));
const report = await snapshots.restore(root, id, version);
const content = await readFile(join(root, 'original.txt'), 'utf8');
assert.deepEqual(await snapshots.restore(root, id, version), report);
const recorded = await readFile(log, 'utf8');
const undo = await snapshots.preview(root, report.undoSnapshotId!);
await snapshots.restore(root, report.undoSnapshotId!, undo.version);
console.log(JSON.stringify({ report, log: recorded, content, undoContent: await readFile(join(root, 'later.txt'), 'utf8') }));
