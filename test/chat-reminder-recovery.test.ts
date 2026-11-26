import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { recoveryTestTimeoutMs, startRecoveryWorker } from './helpers.js';

for (const operation of ['create', 'cancel', 'cancel-saved', 'update', 'update-saved', 'update-cancelled'] as const) test(`SIGKILL during chat reminder ${operation} keeps the original operation identity`, { timeout: recoveryTestTimeoutMs }, async () => {
  const dataDir = await realpath(await mkdtemp(join(tmpdir(), 'kada-chat-reminder-')));
  const fixture = new URL('./fixtures/chat-reminder-worker.ts', import.meta.url);
  let worker = startRecoveryWorker(fixture, 'create', dataDir, operation);
  try {
    const ready = await worker.ready();
    assert.equal(await worker.stop(), 'SIGKILL');
    worker = startRecoveryWorker(fixture, 'recover', dataDir, operation);
    const result = await worker.complete();
    assert.equal(result.rules.length, 1);
    assert.equal(result.rules[0].id, ready.reminderId);
    assert.equal(result.goal, null);
    assert.equal(result.toolError, operation === 'cancel' || operation === 'update');
    if (operation === 'create') assert.equal(result.notifications.length, 1);
    else if (operation === 'cancel') {
      assert.equal(result.rules[0].status, 'scheduled');
      assert.equal(result.rules[0].objective, 'New reminder while cancellation was interrupted');
    } else if (operation === 'update' || operation === 'update-saved') {
      assert.equal(result.rules[0].status, 'scheduled');
      assert.equal(result.rules[0].objective, 'Later user edit in another project');
      assert.equal(result.rules[0].missedPolicy, 'run_once');
      assert.equal(result.rules[0].revision, operation === 'update' ? 2 : 3);
    } else assert.equal(result.rules[0].status, 'cancelled');
    if (operation === 'update-saved' || operation === 'update-cancelled') {
      const receipt = JSON.parse(result.toolResult);
      assert.equal(receipt.objective, 'Chat applied reminder');
      assert.equal(receipt.revision, 2);
      assert.equal(receipt.status, 'scheduled');
    }
    assert.equal(await readFile(join(dataDir, 'model-calls.txt'), 'utf8'), 'model\nmodel\n');
  } finally { await worker.stop(); await rm(dataDir, { recursive: true, force: true, maxRetries: 5 }); }
});
