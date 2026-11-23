import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { pinSkills, runSkillScript, SkillStore, type SkillState } from '../src/skills.js';
import { LocalDiscovery, localContextInstructions } from '../src/discovery.js';
import { Workspace } from '../src/workspace.js';

async function writeSkill(root: string, source: string, name: string, content: string): Promise<string> {
  const path = join(root, source, 'skills', name, 'SKILL.md');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `---\nname: ${name}\ndescription: A fixture skill\n---\n\n${content}\n`);
  return path;
}

test('F09 discovered home Skills share catalogue settings and immutable full-version pins', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kada-home-skills-'));
  try {
    const workspace = await Workspace.open(join(root, 'project'));
    const home = join(root, 'home'), data = join(root, 'data');
    const manifest = await writeSkill(home, '.agents', 'home-recipe', 'Use recipe.mjs and reference.md');
    await writeFile(join(dirname(manifest), 'recipe.mjs'), 'console.log("original recipe");\n');
    await writeFile(join(dirname(manifest), 'reference.md'), 'Original reference\n');
    const discovered = (await new LocalDiscovery(data, { home }).context()).skills;
    const store = await SkillStore.open(data);
    assert.equal((await store.catalog(workspace)).some(skill => skill.name === 'home-recipe'), false, 'historical callers keep their existing sources');
    const entry = (await store.catalog(workspace, discovered)).find(skill => skill.name === 'home-recipe');
    assert.ok(entry?.enabled, 'a discovered Agent Skill appears in the same selectable catalogue');
    assert.equal(entry.source, 'user');
    assert.match(entry.currentVersion ?? '', /^[a-f0-9]{64}$/);
    const withoutManaged = await pinSkills(workspace, join(root, 'without-managed'), undefined, [{ name: 'home-recipe', version: entry.currentVersion }], discovered);
    assert.equal(withoutManaged.pins[0].version, entry.currentVersion, 'discovery works when generated Skill storage is disabled');
    await store.setEnabled('home-recipe', false, workspace, discovered);
    const disabled = await pinSkills(workspace, join(root, 'disabled'), store, undefined, discovered);
    assert.equal(disabled.pins.some(pin => pin.name === 'home-recipe'), false);
    await assert.rejects(pinSkills(workspace, join(root, 'explicit-disabled'), store, [{ name: 'home-recipe' }], discovered), /disabled/);
    await store.setEnabled('home-recipe', true, workspace, discovered);
    const pinned = await pinSkills(workspace, join(root, 'pinned'), store, [{ name: 'home-recipe', version: entry.currentVersion }], discovered);
    assert.equal(pinned.pins.length, 1);
    const pin = pinned.pins[0], files = await Workspace.open(dirname(pin.filePath), { create: false });
    assert.equal(pin.version, entry.currentVersion);
    assert.notEqual(pin.filePath, manifest);
    await writeSkill(home, '.agents', 'home-recipe', 'Changed original recipe');
    await writeFile(join(dirname(manifest), 'recipe.mjs'), 'changed script');
    assert.match(await files.read('SKILL.md'), /Use recipe.mjs and reference.md/);
    assert.equal(await files.read('recipe.mjs'), 'console.log("original recipe");\n');
    assert.equal(await files.read('reference.md'), 'Original reference\n');
    await assert.rejects(pinSkills(workspace, join(root, 'stale-version'), store, [{ name: 'home-recipe', version: entry.currentVersion }], discovered), /unavailable|changed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('F09 project and discovered user Skills precede bundled and managed names with an explanation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kada-home-collision-'));
  try {
    const workspace = await Workspace.open(join(root, 'project'));
    const home = join(root, 'home'), data = join(root, 'data');
    const manifest = await writeSkill(home, '.agents', 'code-work', 'User code recipe');
    const discovered = (await new LocalDiscovery(data, { home }).context()).skills;
    const store = await SkillStore.open(data);
    const user = (await store.catalog(workspace, discovered)).find(skill => skill.name === 'code-work');
    assert.equal(user?.source, 'user');
    assert.deepEqual(user?.shadowed, ['bundled']);
    assert.ok(user.currentVersion);
    await store.files.write(`code-work/${user.currentVersion}/SKILL.md`, await (await Workspace.open(dirname(manifest), { create: false })).read('SKILL.md'));
    await store.files.write('heads.json', JSON.stringify({ 'code-work': { version: user.currentVersion, published: [user.currentVersion] } }));
    assert.deepEqual((await store.catalog(workspace, discovered)).find(skill => skill.name === 'code-work')?.shadowed, ['bundled', 'managed']);
    const userPin = await pinSkills(workspace, join(root, 'user'), store, [{ name: 'code-work' }], discovered);
    assert.match(userPin.notice ?? '', /user.*bundled, managed.*same name/);
    assert.match(await (await Workspace.open(dirname(userPin.pins[0].filePath), { create: false })).read('SKILL.md'), /User code recipe/);
    await writeSkill(workspace.root, '.pi', 'code-work', 'Project code recipe');
    const project = (await store.catalog(workspace, discovered)).find(skill => skill.name === 'code-work');
    assert.equal(project?.source, 'project');
    assert.deepEqual(project?.shadowed, ['user', 'bundled', 'managed']);
    const projectPin = await pinSkills(workspace, join(root, 'project-pin'), store, [{ name: 'code-work' }], discovered);
    assert.match(projectPin.notice ?? '', /project.*user, bundled, managed.*same name/);
    assert.match(await (await Workspace.open(dirname(projectPin.pins[0].filePath), { create: false })).read('SKILL.md'), /Project code recipe/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('F09 originating disabled plugins and oversized discovered Skills cannot be activated through catalogue settings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kada-discovered-limits-'));
  try {
    const workspace = await Workspace.open(join(root, 'project'));
    const home = join(root, 'home'), data = join(root, 'data'), plugin = '.claude/plugins/cache/local/off/1.0.0';
    await writeSkill(home, plugin, 'off-recipe', 'A disabled plugin recipe');
    await writeFile(join(home, '.claude/settings.json'), JSON.stringify({ enabledPlugins: { 'off@local': false } }));
    await writeFile(join(home, '.claude/plugins/installed_plugins.json'), JSON.stringify({ plugins: { 'off@local': [{ installPath: join(home, plugin) }] } }));
    const wide = await writeSkill(home, '.agents', 'wide-recipe', 'An oversized supporting resource');
    await writeFile(join(dirname(wide), 'reference.md'), 'x'.repeat(32769));
    const discovered = (await new LocalDiscovery(data, { home }).context()).skills;
    assert.equal(discovered.find(skill => skill.name === 'off-recipe')?.disabled, true);
    const store = await SkillStore.open(data), catalog = await store.catalog(workspace, discovered);
    assert.equal(catalog.find(skill => skill.name === 'off-recipe')?.enabled, false);
    assert.equal(catalog.find(skill => skill.name === 'wide-recipe')?.enabled, false);
    await assert.rejects(store.setEnabled('off-recipe', true, workspace, discovered), /originating Agent/);
    await assert.rejects(store.setEnabled('wide-recipe', true, workspace, discovered), /size limits/);
    await assert.rejects(pinSkills(workspace, join(root, 'explicit-disabled'), store, [{ name: 'off-recipe' }], discovered), /disabled/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('F09 catalogue task instructions retain environment and memory without raw discovery Skill paths', () => {
  const context = {
    overview: 'LOCAL_OVERVIEW', catalogue: 'RAW_SKILLS_CATALOGUE', guidance: ['USER_GUIDANCE'],
    summary: 'KNOWN_LOCAL_ENVIRONMENT', skills: [{ name: 'raw-skill', description: 'Raw Skill', path: 'ORIGINAL_SKILL_PATH', owner: 'shared', disabled: false }],
    memory: { home: 'HOME', profile: 'MEMORY_PROFILE', evidence: 'MEMORY_EVIDENCE', summary: 'KNOWN_USER_PREFERENCE', facts: 1, sources: 1 },
  };
  const instructions = localContextInstructions(context, { skills: false });
  assert.ok(instructions.includes('KNOWN_LOCAL_ENVIRONMENT'));
  assert.ok(instructions.includes('USER_GUIDANCE'));
  assert.ok(instructions.includes('KNOWN_USER_PREFERENCE'));
  for (const raw of ['RAW_SKILLS_CATALOGUE', 'ORIGINAL_SKILL_PATH', 'raw-skill', 'original Skill directory', 'SKILL.md']) assert.ok(!instructions.includes(raw), raw);
  assert.ok(localContextInstructions(context).includes('RAW_SKILLS_CATALOGUE'), 'historical default still offers original-path discovery');
});

test('C03 a Skill catalog explains disabled, colliding, and changed selections', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kada-skills-'));
  try {
    const workspace = await Workspace.open(join(root, 'project'));
    const store = await SkillStore.open(join(root, 'data'));
    await writeSkill(workspace.root, '.pi', 'fixture', 'First recipe');
    const version = (await store.catalog(workspace)).find(skill => skill.name === 'fixture')?.currentVersion;
    assert.ok(version);
    await store.setEnabled('fixture', false, workspace);
    await assert.rejects(pinSkills(workspace, join(root, 'disabled'), store, [{ name: 'fixture' }]), /disabled/);
    await store.setEnabled('fixture', true, workspace);
    await writeSkill(workspace.root, '.pi', 'fixture', 'Second recipe');
    await assert.rejects(pinSkills(workspace, join(root, 'changed'), store, [{ name: 'fixture', version }]), /unavailable|changed/);
    await writeSkill(workspace.root, '.agents', 'fixture', 'Collision');
    const sameName = (await store.catalog(workspace)).find(skill => skill.name === 'fixture');
    assert.deepEqual(sameName?.shadowed, ['project']);
    const resolved = await pinSkills(workspace, join(root, 'collision'), store, [{ name: 'fixture' }]);
    assert.match(resolved.notice ?? '', /same name/i);
    assert.match(await (await Workspace.open(dirname(resolved.pins[0].filePath), { create: false })).read('SKILL.md'), /Second recipe/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('C04/S02 disabling or editing a Skill leaves its existing task pin intact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kada-skills-'));
  try {
    const workspace = await Workspace.open(join(root, 'project'));
    const store = await SkillStore.open(join(root, 'data'));
    await writeSkill(workspace.root, '.pi', 'fixture', 'First recipe');
    const first = await pinSkills(workspace, join(root, 'old-task'), store, [{ name: 'fixture' }]);
    const [pin] = first.pins;
    await store.setEnabled('fixture', false, workspace);
    await writeSkill(workspace.root, '.pi', 'fixture', 'Second recipe');
    const old = await Workspace.open(dirname(pin.filePath), { create: false });
    assert.match(await old.read('SKILL.md'), /First recipe/);
    assert.equal((await pinSkills(workspace, join(root, 'no-skills'), store, [])).pins.length, 0);
    await store.setEnabled('fixture', true, workspace);
    const second = await pinSkills(workspace, join(root, 'new-task'), store, [{ name: 'fixture' }]);
    assert.notEqual(second.pins[0].version, pin.version);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('S02 records the exact pinned script invocation and forwards each input to native Bash', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kada-skill-use-'));
  try {
    const workspace = await Workspace.open(join(root, 'project'));
    const recipe = await writeSkill(workspace.root, '.pi', 'fixture', 'Run echo.mjs');
    await writeFile(join(dirname(recipe), 'echo.mjs'), 'console.log(process.argv[2]);\n');
    const skills = await pinSkills(workspace, join(root, 'task'), undefined, [{ name: 'fixture' }]);
    const [pin] = skills.pins;
    assert.ok(pin);
    skills.loaded.push(`${pin.name}@${pin.version}`);
    const quoteAndLiteral = "O'Reilly $(literal)";
    const calls: string[] = [];
    const api = {
      commit: async (fn: (tx: { doc: () => { skills: SkillState } }) => Promise<unknown>) => fn({ doc: () => ({ skills }) }),
      executeTool: async (name: string, args: { command: string; timeout: number }) => {
        assert.equal(name, 'bash');
        assert.equal(args.timeout, 60);
        calls.push(args.command);
        return { structuredOutput: { output: 'fixture output', exitCode: 0 }, isError: false };
      },
    } as unknown as Parameters<typeof runSkillScript.execute>[1];
    const ctx = {} as Parameters<typeof runSkillScript.execute>[2];
    const first = await runSkillScript.execute({ name: 'fixture', path: 'echo.mjs', args: ['first'] }, api, ctx);
    assert.deepEqual(first.output, [{ type: 'text', text: 'fixture output' }]);
    await runSkillScript.execute({ name: 'fixture', path: 'echo.mjs', args: [quoteAndLiteral] }, api, ctx);
    assert.match(calls[0], /echo\.mjs' 'first'$/);
    assert.ok(calls[1].endsWith("'O'\\''Reilly $(literal)'"));
    assert.deepEqual(skills.executions?.map(({ name, version, path, ok }) => ({ name, version, path, ok })), [
      { name: 'fixture', version: pin.version, path: 'echo.mjs', ok: true },
      { name: 'fixture', version: pin.version, path: 'echo.mjs', ok: true },
    ]);
    assert.equal(skills.executions?.[0].sha256, skills.executions?.[1].sha256);
    await writeFile(join(dirname(pin.filePath), 'echo.mjs'), 'changed after pin');
    await assert.rejects(runSkillScript.execute({ name: 'fixture', path: 'echo.mjs' }, api, ctx), /changed/);
    assert.equal(calls.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
