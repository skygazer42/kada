import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { recoveryTestTimeoutMs, startRecoveryWorker } from './helpers.js';

for (const stage of ['question-saved', 'chat-answer', 'goal-answer']) test(`SIGKILL after structured ${stage} preserves the original question and one answer`, { timeout: recoveryTestTimeoutMs }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'kada-question-'))), fixture = new URL('./fixtures/question-worker.ts', import.meta.url);
  let worker = startRecoveryWorker(fixture, 'create', directory, stage);
  try {
    await worker.ready(); assert.equal(await worker.stop(), 'SIGKILL');
    worker = startRecoveryWorker(fixture, 'recover', directory, stage);
    const result = await worker.complete();
    assert.equal(result.answers, 1); assert.equal(result.question, null);
    if (stage === 'chat-answer') assert.equal(result.goal, null);
    else assert.deepEqual(result.goal.userMessages, ['CSV']);
    assert.equal(await readFile(join(directory, 'model-calls.txt'), 'utf8'), 'model\nmodel\n');
  } finally { await worker.stop(); await rm(directory, { recursive: true, force: true, maxRetries: 5 }); }
});
