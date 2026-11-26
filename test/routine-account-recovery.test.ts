import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { recoveryTestTimeoutMs, startRecoveryWorker } from './helpers.js';

test('SIGKILL before the next check derives account cooldown from the original Pi refusal without new requests', { timeout: recoveryTestTimeoutMs }, async () => {
  const dataDir = await realpath(await mkdtemp(join(tmpdir(), 'kada-account-recovery-')));
  const fixture = new URL('./fixtures/routine-account-worker.ts', import.meta.url);
  let worker = startRecoveryWorker(fixture, 'create', dataDir);
  try {
    const ready = await worker.ready();
    assert.equal(await worker.stop(), 'SIGKILL');
    worker = startRecoveryWorker(fixture, 'recover', dataDir);
    const result = await worker.complete();
    assert.equal(result.status, 'skipped');
    assert.deepEqual(result.cooldown, { failures: 2, code: 'auth', until: ready.due + 15 * 60_000 });
    assert.equal(result.tasks, 2);
    assert.equal(await readFile(join(dataDir, 'calls.txt'), 'utf8'), 'model\nmodel\n');
  } finally { await worker.stop(); await rm(dataDir, { recursive: true, force: true, maxRetries: 5 }); }
});
