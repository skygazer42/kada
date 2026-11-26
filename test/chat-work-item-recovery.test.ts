import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { recoveryTestTimeoutMs, startRecoveryWorker } from './helpers.js';

for (const scenario of ['create-saved', 'update-before', 'update-saved', 'archive-saved', 'planning-create-saved', 'planning-update-saved']) test(`SIGKILL during chat work item ${scenario} preserves the original operation and later owner edits`, { timeout: recoveryTestTimeoutMs }, async () => {
  const created = scenario.endsWith('create-saved');
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'kada-chat-work-recovery-')));
  const fixture = new URL('./fixtures/chat-work-item-worker.ts', import.meta.url);
  let worker = startRecoveryWorker(fixture, 'create', directory, scenario);
  try {
    const ready = await worker.ready(); assert.equal(await worker.stop(), 'SIGKILL');
    worker = startRecoveryWorker(fixture, 'recover', directory, scenario);
    const result = await worker.complete();
    assert.equal(result.items.length, 1); assert.equal(result.items[0].id, ready.itemId);
    assert.equal(result.items[0].title, 'Later owner change');
    assert.equal(result.items[0].revision, created || scenario === 'update-before' ? 2 : 3);
    assert.equal(result.items[0].archived, scenario !== 'archive-saved');
    assert.equal(result.goal, null); assert.deepEqual(result.runs, []);
    assert.equal(result.toolError, scenario === 'update-before');
    if (!result.toolError) {
      const receipt = JSON.parse(result.result);
      assert.equal(receipt.revision, created ? 1 : 2);
      assert.equal(receipt.title, scenario.endsWith('update-saved') ? 'Chat updated' : created ? 'Chat saved' : 'Original');
      assert.equal(receipt.archived, scenario === 'archive-saved');
      if (scenario.startsWith('planning-')) {
        assert.equal(receipt.priority, created ? 'high' : 'urgent');
        assert.equal(receipt.timeZone, 'America/New_York');
        assert.equal(created ? receipt.dueDate : receipt.dueAt, created ? '2026-12-01' : '2026-12-02T22:00:00.000Z');
        assert.equal(result.items[0].priority, 'low'); assert.equal(result.items[0].dueDate, '2030-01-02');
        assert.equal(result.items[0].dueAt, null); assert.equal(result.items[0].timeZone, 'Asia/Tokyo');
      }
    }
    assert.equal(await readFile(join(directory, 'model-calls.txt'), 'utf8'), 'model\nmodel\n');
  } finally { await worker.stop(); await rm(directory, { recursive: true, force: true, maxRetries: 5 }); }
});
