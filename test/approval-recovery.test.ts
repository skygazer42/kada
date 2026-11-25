import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { recoveryTestTimeoutMs, startRecoveryWorker } from './helpers.js';

for (const stage of ['pending', 'dispatched']) test(`SIGKILL during an approval ${stage} preserves a single action and report`, { timeout: recoveryTestTimeoutMs }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'kada-approval-crash-')));
  const fixture = new URL('./fixtures/approval-worker.ts', import.meta.url);
  let worker = startRecoveryWorker(fixture, 'create', directory, stage);
  try {
    const before = await worker.ready();
    assert.equal(await worker.stop(), 'SIGKILL');
    worker = startRecoveryWorker(fixture, 'recover', directory, stage);
    const after = await worker.complete();
    assert.equal(after.taskId, before.taskId);
    assert.equal(after.approvalId, before.approvalId);
    assert.equal(after.status, stage === 'pending' ? 'denied' : 'uncertain');
    assert.equal(after.effects, stage === 'pending' ? '' : 'crash-once\n');
    assert.equal(after.reports, 1);
  } finally { await worker.stop(); await rm(directory, { recursive: true, force: true, maxRetries: 5 }); }
});
