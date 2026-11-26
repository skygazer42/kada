import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareAssistantFiles, copyAssistantFiles } from '../src/assistant-files.js';
import { Workspace } from '../src/workspace.js';

async function fixture(t: test.TestContext) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'kada-assistant-files-'))), root = join(directory, 'workspace');
  await mkdir(root); const workspace = await Workspace.open(root);
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5 }));
  return { directory, root, workspace };
}

test('assistant input copies preserve binary and empty bytes, original hashes and work identities after source edits', async t => {
  const f = await fixture(t), binary = Buffer.from([0, 255, 128, 17]);
  await writeFile(join(f.root, 'same.bin'), binary); await writeFile(join(f.root, 'empty.txt'), '');
  const files = await prepareAssistantFiles(f.workspace, 'assign-817', ['same.bin', 'empty.txt']);
  assert.equal(files[0]!.sourcePath, join(f.root, 'same.bin')); assert.equal(files[0]!.sha256, createHash('sha256').update(binary).digest('hex'));
  assert.notEqual(files[0]!.path, files[0]!.sourcePath); assert(files.every(file => file.path.includes('assign-817')));
  await copyAssistantFiles(f.workspace, files);
  assert.deepEqual(await readFile(files[0]!.path), binary); assert.equal((await readFile(files[1]!.path)).length, 0);
  await writeFile(join(f.root, 'same.bin'), 'Later source version');
  await copyAssistantFiles(f.workspace, files); assert.deepEqual(await readFile(files[0]!.path), binary);
  const next = await prepareAssistantFiles(f.workspace, 'assign-928', ['same.bin']); await copyAssistantFiles(f.workspace, next);
  assert.notEqual(next[0]!.path, files[0]!.path); assert.equal(await readFile(next[0]!.path, 'utf8'), 'Later source version');
});

test('assistant file admission rejects too many, oversized, foreign, duplicate and linked paths before delivery', async t => {
  const f = await fixture(t); await writeFile(join(f.root, 'seed.txt'), 'Original');
  await writeFile(join(f.root, 'big.bin'), Buffer.alloc(5 * 1024 * 1024 + 1));
  await writeFile(join(f.directory, 'outside.txt'), 'Private');
  await assert.rejects(prepareAssistantFiles(f.workspace, 'assign-1', Array.from({ length: 6 }, () => 'seed.txt')));
  await assert.rejects(prepareAssistantFiles(f.workspace, 'assign-1', ['big.bin']), /5 MiB/);
  await assert.rejects(prepareAssistantFiles(f.workspace, 'assign-1', ['../outside.txt']), /outside/);
  await assert.rejects(prepareAssistantFiles(f.workspace, 'assign-1', ['seed.txt', './seed.txt']), /duplicate/i);
  await assert.rejects(prepareAssistantFiles(f.workspace, '../unsafe', ['seed.txt']));
  const link = join(f.root, 'linked'); await symlink(f.directory, link, 'junction');
  await assert.rejects(prepareAssistantFiles(f.workspace, 'assign-1', ['linked/outside.txt']), /Symlinks/);
});

test('changed original bytes and a modified saved input fail explicitly without overwriting another version', async t => {
  const f = await fixture(t); await writeFile(join(f.root, 'seed.txt'), 'Original');
  const files = await prepareAssistantFiles(f.workspace, 'assign-1', ['seed.txt']);
  await writeFile(join(f.root, 'seed.txt'), 'Changed'); await assert.rejects(copyAssistantFiles(f.workspace, files), /changed/i);
  await assert.rejects(readFile(files[0]!.path), { code: 'ENOENT' });
  await writeFile(join(f.root, 'seed.txt'), 'Original'); await copyAssistantFiles(f.workspace, files);
  await writeFile(files[0]!.path, 'Later recipient edit');
  await assert.rejects(copyAssistantFiles(f.workspace, files), /changed/i); assert.equal(await readFile(files[0]!.path, 'utf8'), 'Later recipient edit');
});

test('concurrent replay creates one immutable input copy and never overwrites a competing file', async t => {
  const f = await fixture(t); await writeFile(join(f.root, 'seed.txt'), 'Original');
  const files = await prepareAssistantFiles(f.workspace, 'assign-1', ['seed.txt']);
  await Promise.all([copyAssistantFiles(f.workspace, files), copyAssistantFiles(f.workspace, files)]);
  assert.equal(await readFile(files[0]!.path, 'utf8'), 'Original');
  const refused = await prepareAssistantFiles(f.workspace, 'assign-2', ['seed.txt']);
  await mkdir(join(f.root, 'agents', 'assistant-work', 'assign-2', 'inputs'), { recursive: true });
  await writeFile(refused[0]!.path, 'Another original file');
  await assert.rejects(copyAssistantFiles(f.workspace, refused), /changed/i);
  assert.equal(await readFile(refused[0]!.path, 'utf8'), 'Another original file');
});

test('a source modified during copying never becomes a successful fixed input', async t => {
  const f = await fixture(t); await writeFile(join(f.root, 'seed.txt'), 'Original');
  const files = await prepareAssistantFiles(f.workspace, 'assign-1', ['seed.txt']), inspect = f.workspace.inspect.bind(f.workspace);
  f.workspace.inspect = async (...args) => {
    if (args[0] === files[0]!.sourcePath) await writeFile(join(f.root, 'seed.txt'), 'Changed during checking');
    return inspect(...args);
  };
  await assert.rejects(copyAssistantFiles(f.workspace, files), /changed/i);
  await assert.rejects(readFile(files[0]!.path), { code: 'ENOENT' });
});
