import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { recoveryTestTimeoutMs, startRecoveryWorker } from './helpers.js';

test('SIGKILL after activity-gated admission reuses the original task, allowed decision and start time', { timeout: recoveryTestTimeoutMs }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'kada-activity-recovery-')));
  const fixture = new URL('./fixtures/routine-activity-worker.ts', import.meta.url);
  let worker = startRecoveryWorker(fixture, 'create', directory);
  try {
    const ready = await worker.ready();
    assert.equal(await worker.stop(), 'SIGKILL');
    worker = startRecoveryWorker(fixture, 'recover', directory);
    const result = await worker.complete();
    assert.equal(result.type, 'completed');
    assert.equal(result.taskId, ready.taskId);
    assert.equal(result.startedAt, ready.createdAt);
    assert.equal(result.createdAt, ready.createdAt);
    assert.equal(result.queries, 0);
    assert.equal(result.tasks, 2);
    assert.equal(result.cooldown, 'skipped');
    assert.deepEqual(result.history, [['claimed', 'allowed', ready.taskId], ['started', 'allowed', ready.taskId]]);
    assert.equal(await readFile(join(directory, 'model-calls.txt'), 'utf8'), 'model\nmodel\n');
  } finally { await worker.stop(); await rm(directory, { recursive: true, force: true, maxRetries: 5 }); }
});
