import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

test('the live handoff comparison reports provider quota failure without echoing the upstream error', async t => {
  const parent = await realpath(tmpdir());
  const directory = await realpath(await mkdtemp(join(parent, 'kada-comparison-')));
  assert.equal(dirname(directory), parent);
  assert(basename(directory).startsWith('kada-comparison-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const response = `globalThis.fetch = async () => Response.json({ error: {
    code: 'insufficient_quota', message: 'upstream private diagnostic',
  } }, { status: 402, statusText: 'Payment Required' });`;
  const preload = 'data:text/javascript,' + encodeURIComponent(response);
  const script = fileURLToPath(new URL('../scripts/compare-assistant-handoff.ts', import.meta.url));
  await assert.rejects(promisify(execFile)(process.execPath, [
    '--import', import.meta.resolve('tsx'), '--import', preload, script, '--live', '--arm=pi',
  ], {
    cwd: directory,
    env: { ...process.env, SILICONFLOW_API_KEY: 'synthetic-key', SILICONFLOW_MODEL: 'deepseek-ai/DeepSeek-V3.2' },
    timeout: 45_000,
  }), (error: Error & { code?: number; signal?: string; stdout?: string; stderr?: string }) => {
    assert.equal(error.code, 1, error.signal ? `Comparison process ended with ${error.signal}` : 'Expected a failed comparison exit');
    const [first] = (error.stdout ?? '').trim().split('\n');
    const result = JSON.parse(first!);
    assert.equal(result.passed, false);
    assert.equal(result.modelRequests, 1);
    assert.deepEqual(result.failure, { stage: 'first_turn', reason: 'provider_account_refusal', accountRefusal: 'quota' });
    assert.doesNotMatch((error.stdout ?? '') + (error.stderr ?? ''), /upstream private diagnostic|synthetic-key/);
    return true;
  });
});
