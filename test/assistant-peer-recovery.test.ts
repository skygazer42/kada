import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { recoveryTestTimeoutMs, startRecoveryWorker } from './helpers.js';

for (const stage of ['assignment-before-receipt', 'effect-before-receipt', 'report-before-receipt']) {
  test('SIGKILL at assistant peer ' + stage + ' preserves original work and does not duplicate effects or reports', { timeout: recoveryTestTimeoutMs }, async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'kada-peer-recovery-'))), fixture = new URL('./fixtures/assistant-peer-worker.ts', import.meta.url);
    let worker = startRecoveryWorker(fixture, 'create', directory, stage);
    try {
      await worker.ready(); assert.equal(await worker.stop(), 'SIGKILL');
      worker = startRecoveryWorker(fixture, 'recover', directory, stage);
      const result = await worker.complete();
      assert.equal(result.workCount, 1); assert.equal(result.seatCount, 1); assert.equal(result.peerInputs, 1); assert.equal(result.reports, 1);
      assert.equal(result.originalRevision, 1); assert.equal(result.latestRevision, 2); assert.equal(result.effects, 'original-effect\n'); assert.equal(result.result, 'done');
    } finally { await worker.stop(); await rm(directory, { recursive: true, force: true, maxRetries: 5 }); }
  });
}

for (const stage of ['input-copies-before-claim', 'output-copies-before-receipt']) {
  test('SIGKILL at assistant peer ' + stage + ' reuses original binary copies after source files change', { timeout: recoveryTestTimeoutMs }, async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'kada-peer-file-recovery-'))), fixture = new URL('./fixtures/assistant-peer-worker.ts', import.meta.url);
    let worker = startRecoveryWorker(fixture, 'create', directory, stage);
    try {
      await worker.ready(); assert.equal(await worker.stop(), 'SIGKILL');
      worker = startRecoveryWorker(fixture, 'recover', directory, stage);
      const result = await worker.complete();
      assert.equal(result.workCount, 1); assert.equal(result.seatCount, 1); assert.equal(result.peerInputs, 1); assert.equal(result.reports, 1);
      assert.equal(result.effects, 'original-effect\n'); assert.equal(result.result, 'done');
      assert.equal(stage === 'input-copies-before-claim' ? result.inputsKept : result.outputsKept, true);
    } finally { await worker.stop(); await rm(directory, { recursive: true, force: true, maxRetries: 5 }); }
  });
}

for (const stage of ['stop-requested', 'stop-confirmed-before-boundary']) {
  test('SIGKILL at assistant peer ' + stage + ' keeps the stopped work stopped and runs its original queued sibling once', { timeout: recoveryTestTimeoutMs }, async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'kada-peer-stop-recovery-'))), fixture = new URL('./fixtures/assistant-peer-worker.ts', import.meta.url);
    let worker = startRecoveryWorker(fixture, 'create', directory, stage);
    try {
      await worker.ready(); assert.equal(await worker.stop(), 'SIGKILL');
      worker = startRecoveryWorker(fixture, 'recover', directory, stage);
      const result = await worker.complete();
      assert.equal(result.workCount, 2); assert.equal(result.seatCount, 1); assert.equal(result.peerInputs, 2); assert.equal(result.reports, 1);
      assert.equal(result.stopped, 1); assert.equal(result.queuedDone, 1); assert.equal(result.effects, 'original-effect\n');
      assert.equal(result.originalRevision, 1); assert.equal(result.latestRevision, 2);
    } finally { await worker.stop(); await rm(directory, { recursive: true, force: true, maxRetries: 5 }); }
  });
}
