import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { recoveryTestTimeoutMs, startRecoveryWorker } from './helpers.js';

for (const scenario of ['create-saved', 'update-before', 'update-saved', 'archive-saved']) test(`SIGKILL during chat work item ${scenario} preserves the original operation and later owner edits`, { timeout: recoveryTestTimeoutMs }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'kada-chat-work-recovery-')));
  const fixture = new URL('./fixtures/chat-work-item-worker.ts', import.meta.url);
  let worker = startRecoveryWorker(fixture, 'create', directory, scenario);
  try {
    const ready = await worker.ready(); assert.equal(await worker.stop(), 'SIGKILL');
    worker = startRecoveryWorker(fixture, 'recover', directory, scenario);
    const result = await worker.complete();
    assert.equal(result.items.length, 1); assert.equal(result.items[0].id, ready.itemId);
    assert.equal(result.items[0].title, 'Later owner change');
    assert.equal(result.items[0].revision, scenario === 'create-saved' || scenario === 'update-before' ? 2 : 3);
    assert.equal(result.items[0].archived, scenario !== 'archive-saved');
    assert.equal(result.goal, null); assert.deepEqual(result.runs, []);
    assert.equal(result.toolError, scenario === 'update-before');
    if (!result.toolError) {
      const receipt = JSON.parse(result.result);
      assert.equal(receipt.revision, scenario === 'create-saved' ? 1 : 2);
      assert.equal(receipt.title, scenario === 'update-saved' ? 'Chat updated' : scenario === 'create-saved' ? 'Chat saved' : 'Original');
      assert.equal(receipt.archived, scenario === 'archive-saved');
    }
    assert.equal(await readFile(join(directory, 'model-calls.txt'), 'utf8'), 'model\nmodel\n');
  } finally { await worker.stop(); await rm(directory, { recursive: true, force: true, maxRetries: 5 }); }
});
