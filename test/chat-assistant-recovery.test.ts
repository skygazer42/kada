import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { recoveryTestTimeoutMs, startRecoveryWorker } from './helpers.js';

for (const stage of ['create-saved', 'update-before', 'update-saved', 'archive-saved', 'noop-saved']) {
  test('SIGKILL during assistant configuration ' + stage + ' preserves the original receipt and later owner settings', { timeout: recoveryTestTimeoutMs }, async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'kada-chat-assistant-'))), fixture = new URL('./fixtures/chat-assistant-worker.ts', import.meta.url);
    let worker = startRecoveryWorker(fixture, 'create', directory, stage);
    try {
      const ready = await worker.ready(); assert.equal(await worker.stop(), 'SIGKILL');
      worker = startRecoveryWorker(fixture, 'recover', directory, stage);
      const result = await worker.complete();
      assert.equal(result.roles.length, 1); assert.equal(result.roles[0].id, ready.roleId);
      assert.equal(result.current.name, 'Later owner change'); assert.equal(result.current.instructions, 'Later owner instructions.');
      assert.deepEqual(result.current.tools, ['read', 'write']); assert.equal(result.current.archived, stage !== 'archive-saved');
      assert.equal(result.current.revision, ['create-saved', 'update-before', 'noop-saved'].includes(stage) ? 2 : 3);
      assert.equal(result.goal, null); assert.equal(result.assistantPin, null); assert.equal(result.tasks, 1);
      assert.equal(result.toolError, stage === 'update-before');
      if (!result.toolError) {
        const receipt = JSON.parse(result.receipt);
        assert.equal(receipt.assistant.name, 'Original reader'); assert.equal(receipt.started, false);
        assert.equal(receipt.assistant.revision, ['create-saved', 'noop-saved'].includes(stage) ? 1 : 2);
        assert.equal(receipt.assistant.archived, stage === 'archive-saved');
      }
      assert.doesNotMatch(JSON.stringify([result.current, result.roles, result.receipt]), /operations|fingerprint/);
      assert.equal(await readFile(join(directory, 'model-calls.txt'), 'utf8'), 'model\nmodel\n');
    } finally { await worker.stop(); await rm(directory, { recursive: true, force: true, maxRetries: 5 }); }
  });
}
