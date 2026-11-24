import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import { cloudModels } from '../src/models.js';
import { ProviderSettings } from '../src/provider-settings.js';
import { LocalRuntime } from '../src/runtime.js';

const ref = { provider: 'siliconflow', modelId: 'Qwen/Qwen2.5-7B-Instruct' };

test('SiliconFlow is a Pi provider and a successful check permits durable selection', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kada-provider-'));
  try {
    const models = cloudModels();
    assert.equal(models.getModel(ref.provider, ref.modelId)?.api, 'openai-completions');
    models.checkAuth = async provider => provider === ref.provider ? { type: 'api_key', source: 'fixture-secret' } : undefined;
    const settings = new ProviderSettings(dir, models, async () => ({ status: 'available' }));
    const check = await settings.check(ref);
    assert.equal(check.status, 'available');
    await settings.select(ref);
    assert.deepEqual(await new ProviderSettings(dir, models).selected(), ref);
    const listed = await settings.list();
    const provider = listed.find(item => item.id === ref.provider);
    assert.deepEqual(provider?.authentication, { configured: true, source: 'api_key' });
    assert.equal(provider?.models.find(model => model.id === ref.modelId)?.check?.status, 'available');
    assert.doesNotMatch(JSON.stringify(listed), /fixture-secret/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a checked project default persists under the same root used for project memory', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'kada-provider-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const project = join(dir, 'project');
  const nested = join(project, 'nested');
  const neighbor = join(dir, 'neighbor');
  await Promise.all([mkdir(nested, { recursive: true }), mkdir(neighbor)]);
  await writeFile(join(project, '.kada-project'), '');
  const marker = join(project, '.kada-project');
  const models = cloudModels();
  const global = { provider: ref.provider, modelId: 'deepseek-ai/DeepSeek-V3.2' };
  const settings = new ProviderSettings(dir, models, async () => ({ status: 'available' }));

  await settings.select(global);
  await assert.rejects(settings.select(ref, project), /successful.*check/i);
  await settings.check(ref);
  await assert.rejects(settings.select(ref, marker), /existing directory/i);
  await settings.select(ref, nested);

  const reopened = new ProviderSettings(dir, models);
  assert.deepEqual(await reopened.selected(undefined, project), ref);
  assert.deepEqual(await reopened.selected(undefined, nested), ref);
  const futureWorkspace = join(project, 'different', 'missing');
  assert.deepEqual(await reopened.selected(undefined, futureWorkspace), ref);
  await assert.rejects(stat(futureWorkspace), { code: 'ENOENT' });
  assert.deepEqual(await reopened.selected(undefined, neighbor), global);
  assert.deepEqual(await reopened.selected(), global);
  const entries = (await reopened.list(undefined, project)).find(provider => provider.id === ref.provider)?.models;
  assert.deepEqual(entries?.filter(model => model.selected).map(model => model.id), [ref.modelId]);
});

test('clearing a project default restores the global model and a repeated clear leaves settings intact', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'kada-provider-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const project = join(dir, 'project');
  const nested = join(project, 'nested');
  await mkdir(nested, { recursive: true });
  await writeFile(join(project, '.kada-project'), '');
  const global = { provider: ref.provider, modelId: 'deepseek-ai/DeepSeek-V3.2' };
  const models = cloudModels();
  const settings = new ProviderSettings(dir, models, async () => ({ status: 'available' }));
  await settings.select(global);
  await settings.check(ref);
  await settings.select(ref, project);

  await settings.clear(nested);
  await settings.clear(project);
  const reopened = new ProviderSettings(dir, models);
  assert.deepEqual(await reopened.selected(undefined, project), global);
  assert.deepEqual(await reopened.selected(), global);
  assert.equal((await reopened.list(undefined, nested)).find(provider => provider.id === ref.provider)?.models.find(model => model.id === ref.modelId)?.check?.status, 'available');
});

test('task creation validates its model before creating a new workspace', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'kada-provider-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const runtime = new LocalRuntime({ dataDir: dir, port: 4317, maxSubagents: 0, maxDurationMs: 30_000 }, { models: cloudModels() });
  const workspace = join(dir, 'missing', 'workspace');
  try {
    await assert.rejects(runtime.create('A task without a configured model', workspace), /No model configured/);
    await assert.rejects(stat(join(dir, 'missing')), { code: 'ENOENT' });
  } finally {
    await runtime.close();
  }
});

test('C01 provider check failures report safe error codes and preserve the previous selection', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'kada-provider-'));
  try {
    const models = cloudModels();
    const missing = { provider: ref.provider, modelId: 'missing/model' };
    const previous = { provider: ref.provider, modelId: 'deepseek-ai/DeepSeek-V3.2' };
    const settings = new ProviderSettings(dir, models);
    await settings.select(previous);
    await t.test('unknown model', async () => {
      assert.equal((await settings.check(missing)).code, 'unknown_model');
      await assert.rejects(settings.select(missing), /Unknown model/);
    });
    await t.test('missing credentials from Pi auth resolution', async t => {
      t.mock.method(models, 'getAuth', async () => undefined);
      assert.equal((await settings.check(ref)).code, 'missing_credentials');
    });
    await t.test('401 rejection', async t => {
      t.mock.method(models, 'complete', async () => { throw new Error('401 invalid API key fixture-secret-value'); });
      const check = await settings.check(ref);
      assert.equal(check.code, 'auth');
      assert.doesNotMatch(JSON.stringify(check), /fixture-secret-value/);
      await assert.rejects(settings.select(ref), /credentials/i);
    });
    await t.test('429 provider response', async t => {
      t.mock.method(models, 'complete', async () => fauxAssistantMessage('', { stopReason: 'error', errorMessage: '429' }));
      assert.equal((await settings.check(ref)).code, 'rate_limit');
    });
    await t.test('provider check deadline', async t => {
      const deadline = new AbortController();
      const timeout = t.mock.method(AbortSignal, 'timeout', (delay: number) => {
        assert.equal(delay, 15_000);
        return deadline.signal;
      });
      t.mock.method(models, 'complete', async (_model, _context, options) => {
        assert.equal(options?.signal, deadline.signal);
        deadline.abort();
        return fauxAssistantMessage('', { stopReason: 'aborted' });
      });
      const checking = settings.check(ref);
      timeout.mock.restore();
      assert.equal((await checking).code, 'timeout');
    });
    assert.deepEqual(await settings.selected(), previous);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
