import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createModels, fauxProvider } from '@earendil-works/pi-ai';
import { Assistants, assistantRef } from '../src/assistants.js';

async function fixture(t: test.TestContext) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'kada-assistants-'))), project = join(directory, 'project'), other = join(directory, 'other'), sub = join(project, 'src');
  await mkdir(join(project, '.git'), { recursive: true }); await mkdir(sub); await mkdir(other);
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5 }));
  const models = createModels(), provider = fauxProvider({ provider: 'role-models', models: [{ id: 'reader' }, { id: 'writer' }] });
  models.setProvider(provider.provider);
  const open = () => new Assistants(directory, models);
  return { directory, project, other, sub, models, roles: open(), open, file: join(directory, 'assistants.json') };
}
const definition = { name: '研究员', instructions: 'Read the original sources and cite evidence.', tools: ['read', 'history_search'] };

test('assistant definitions persist by project and revision, select from subdirectories and archive without deleting history', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.roles.list(f.project), []);
  const instructions = '  Preserve the literal directory e\u0301.\n  Keep these code points.  ';
  const role = await f.roles.create({ ...definition, instructions, workspace: f.project });
  assert.equal(role.instructions, instructions);
  assert.equal(role.revision, 1); assert.equal(role.project, f.project); assert.equal(role.model, null); assert.equal(role.archived, false);
  assert.deepEqual(role.tools, ['history_search', 'read']);
  const list = await f.roles.list(f.sub);
  assert.equal(list[0].id, role.id); assert(!Object.hasOwn(list[0], 'instructions'));
  assert.deepEqual(await f.roles.list(f.other), []);
  assert.deepEqual(await f.open().select(f.sub, { id: role.id, revision: 1 }), role);
  await assert.rejects(f.roles.select(f.other, { id: role.id, revision: 1 }), { status: 404 });
  const edited = await f.roles.update(role.id, { revision: 1, name: '分析员', model: { provider: 'role-models', modelId: 'reader' }, tools: ['read'] });
  assert.equal(edited.revision, 2); assert.equal(edited.instructions, role.instructions);
  assert.deepEqual((await f.open().get(role.id)).model, { provider: 'role-models', modelId: 'reader' });
  await assert.rejects(f.roles.select(f.project, { id: role.id, revision: 1 }), { status: 409 });
  const archived = await f.roles.update(role.id, { revision: 2, archived: true });
  assert.equal(archived.revision, 3);
  await assert.rejects(f.roles.select(f.project, { id: role.id, revision: 3 }), { status: 409 });
  assert.equal((await f.open().list(f.project))[0].archived, true);
  assert.equal((await f.open().get(role.id)).instructions, role.instructions);
  const restored = await f.roles.update(role.id, { revision: 3, archived: false, model: null });
  assert.equal(restored.revision, 4); assert.equal(restored.model, null);
});

test('assistant edits serialize conflicts, normalize duplicate names and preserve no-op revisions and other projects', async t => {
  const f = await fixture(t), role = await f.roles.create({ ...definition, name: 'Reader', workspace: f.project });
  await assert.rejects(f.roles.create({ ...definition, name: ' reader ', workspace: f.project }), { status: 409 });
  await f.roles.create({ ...definition, name: 'Reader', workspace: f.other });
  const other = await f.roles.create({ ...definition, name: 'Writer', workspace: f.project });
  await assert.rejects(f.roles.update(other.id, { revision: 1, name: 'READER' }), { status: 409 });
  const bytes = await readFile(f.file, 'utf8');
  assert.deepEqual(await f.roles.update(role.id, { revision: 1, name: 'Reader', tools: ['read', 'history_search'] }), role);
  assert.equal(await readFile(f.file, 'utf8'), bytes);
  const edits = await Promise.allSettled([
    f.roles.update(role.id, { revision: 1, description: 'First' }), f.roles.update(role.id, { revision: 1, instructions: 'Late edit.' }),
  ]);
  assert.equal(edits.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal((edits.find(result => result.status === 'rejected') as PromiseRejectedResult).reason.status, 409);
  assert.equal((await f.roles.get(role.id)).revision, 2); assert.equal((await f.roles.list(f.other)).length, 1);
});

test('invalid role configuration and references leave original definitions intact', async t => {
  const f = await fixture(t), role = await f.roles.create({ ...definition, workspace: f.project });
  const bytes = await readFile(f.file, 'utf8');
  for (const fields of [{ name: '' }, { name: 'x'.repeat(81) }, { name: 'Reader\nWriter' }, { name: 'Reader\x1b[2J' }, { instructions: ' ' }, { instructions: 'a\0b' }, { instructions: 'x'.repeat(16001) },
    { tools: ['read', 'read'] }, { tools: ['*'] }, { tools: [''] }, { tools: ['read\nwrite'] }, { tools: null },
    { model: { provider: 'role-models', modelId: 'missing' } }, { model: { provider: 'role-models', modelId: 'reader', apiKey: 'invalid-field' } },
    { permission: 'all' }, { description: '\0' }]) {
    await assert.rejects(f.roles.create({ ...definition, workspace: f.project, ...fields }), { status: 400 });
    await assert.rejects(f.roles.update(role.id, { revision: 1, ...fields }), { status: 400 });
    assert.equal(await readFile(f.file, 'utf8'), bytes);
  }
  await assert.rejects(f.roles.update(role.id, { revision: 1, project: f.other }), { status: 400 });
  await assert.rejects(f.roles.update(role.id, { revision: 1 }), { status: 400 });
  for (const ref of [null, {}, { id: role.id, revision: 0 }, { id: role.id, revision: 1, tools: ['write'] }, { id: '../foreign', revision: 1 }]) assert.throws(() => assistantRef(ref));
  assert.deepEqual(assistantRef({ revision: 1, id: role.id }), { id: role.id, revision: 1 });
});

test('corrupt catalog data fails visibly without clearing it; an unavailable model remains readable but cannot be selected', async t => {
  const f = await fixture(t), role = await f.roles.create({ ...definition, workspace: f.project, model: { provider: 'role-models', modelId: 'reader' } });
  await assert.rejects(f.roles.update(role.id, { revision: 1, model: undefined }), { status: 400 });
  assert.equal((await f.roles.get(role.id)).model?.modelId, 'reader');
  const unavailable = new Assistants(f.directory, createModels());
  assert.equal((await unavailable.get(role.id)).model?.modelId, 'reader');
  await assert.rejects(unavailable.select(f.project, { id: role.id, revision: 1 }), { status: 400 });
  assert.equal((await unavailable.update(role.id, { revision: 1, archived: true })).archived, true);
  for (const bytes of ['{broken', '{}', JSON.stringify([{ ...role, tools: ['*'] }]), JSON.stringify([role, role])]) {
    await writeFile(f.file, bytes);
    await assert.rejects(f.roles.list(f.project), /Stored assistant/);
    await assert.rejects(f.roles.create({ ...definition, workspace: f.project }), /Stored assistant/);
    assert.equal(await readFile(f.file, 'utf8'), bytes);
  }
});
