import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { cloudModels } from '../src/models.js';
import { ProviderSettings } from '../src/provider-settings.js';

const ref = { provider: 'siliconflow', modelId: 'Qwen/Qwen2.5-7B-Instruct' };

test('C01 SiliconFlow is a Pi provider and a successful check permits durable selection', async () => {
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

test('C02 a failed provider check reports a safe error and preserves the previous selection', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kada-provider-'));
  try {
    const models = cloudModels();
    const missing = { provider: ref.provider, modelId: 'missing/model' };
    models.complete = async () => { throw new Error('401 invalid API key fixture-secret-value'); };
    const settings = new ProviderSettings(dir, models);
    assert.equal((await settings.check(missing)).code, 'unknown_model');
    const check = await settings.check(ref);
    assert.equal(check.code, 'auth');
    assert.doesNotMatch(JSON.stringify(check), /fixture-secret-value/);
    await assert.rejects(settings.select(ref), /credentials/i);
    assert.deepEqual(await settings.selected(missing), missing);
    await assert.rejects(settings.select(missing), /Unknown model/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
