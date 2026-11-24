import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import { cloudModels } from '../src/models.js';
import { ProviderSettings } from '../src/provider-settings.js';

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
