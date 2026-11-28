import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { recoveryTestTimeoutMs, startRecoveryWorker } from './helpers.js';

for (const scenario of ['baseline', 'admitted'] as const) test(`SIGKILL after an HTTP ${scenario} receipt retains its original Pi occurrence and effects`, { timeout: recoveryTestTimeoutMs }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'kada-http-recovery-')));
  const fixture = new URL('./fixtures/routine-http-worker.ts', import.meta.url);
  let worker = startRecoveryWorker(fixture, 'create', directory, scenario);
  try {
    await worker.ready();
    assert.equal(await worker.stop(), 'SIGKILL');
    if (scenario === 'admitted') assert.equal(await readFile(join(directory, 'workspace', 'effects.txt'), 'utf8'), 'effect\n');
    worker = startRecoveryWorker(fixture, 'recover', directory, scenario);
    const result = await worker.complete();
    assert.equal(result.type, 'completed');
    if (scenario === 'baseline') {
      assert.deepEqual(result.statuses, ['baseline', 'unchanged']);
      assert.equal(result.modelRequests, 0);
      assert.equal(result.requests, 1);
    } else {
      assert.equal(result.tasks.length, 1);
      assert.deepEqual(result.history, [['claimed', result.tasks[0]], ['started', result.tasks[0]]]);
      assert.equal(result.requests, 0);
      assert.equal(await readFile(join(directory, 'workspace', 'effects.txt'), 'utf8'), 'effect\n');
    }
  } finally { await worker.stop(); await rm(directory, { recursive: true, force: true, maxRetries: 5 }); }
});
