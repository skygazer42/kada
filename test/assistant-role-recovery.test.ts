import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { recoveryTestTimeoutMs, startRecoveryWorker } from './helpers.js';

for (const stage of ['meta-saved', 'read-pending']) test('SIGKILL at assistant ' + stage + ' preserves the original pin after the catalog gains write permission', { timeout: recoveryTestTimeoutMs }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'kada-role-recovery-'))), fixture = new URL('./fixtures/assistant-role-worker.ts', import.meta.url);
  let worker = startRecoveryWorker(fixture, 'create', directory, stage);
  try {
    await worker.ready(); assert.equal(await worker.stop(), 'SIGKILL');
    worker = startRecoveryWorker(fixture, 'recover', directory, stage);
    const result = await worker.complete();
    assert.equal(result.status, 'completed'); assert.equal(result.latestRevision, 2); assert.equal(result.roleRevision, 1);
    assert.equal(result.roleName, 'Original reader'); assert.equal(result.model, 'role-reader'); assert.equal(result.oldInstructions, true);
    assert.equal(result.forbidden, false); assert.equal(result.calls, 'reader\nreader\nreader\n');
  } finally { await worker.stop(); await rm(directory, { recursive: true, force: true, maxRetries: 5 }); }
});
