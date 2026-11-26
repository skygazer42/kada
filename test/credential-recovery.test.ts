import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { recoveryTestTimeoutMs, startRecoveryWorker } from './helpers.js';
import { createServer } from 'node:http';

for (const stage of ['store-saved', 'chat-answer', 'goal-answer']) test(`SIGKILL after protected credential ${stage} returns the original receipt without overwriting rotation`, { timeout: recoveryTestTimeoutMs }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'kada-credential-recovery-'))), fixture = new URL('./fixtures/credential-worker.ts', import.meta.url);
  let worker = startRecoveryWorker(fixture, 'create', directory, stage);
  try {
    await worker.ready(); assert.equal(await worker.stop(), 'SIGKILL');
    worker = startRecoveryWorker(fixture, 'recover', directory, stage);
    const result = await worker.complete();
    assert.equal(result.revision, 2); assert.equal(result.replacementKept, true); assert.equal(result.oldValueAbsent, true);
    assert.equal(result.answers, 1); assert.equal(result.goal, stage === 'goal-answer' ? 'existing' : null);
    assert.equal(await readFile(join(directory, 'model-calls.txt'), 'utf8'), 'model\nmodel\n');
  } finally { await worker.stop(); await rm(directory, { recursive: true, force: true, maxRetries: 5 }); }
});

test('SIGKILL after an authenticated API dispatch never resends the interrupted Pi tool', { timeout: recoveryTestTimeoutMs }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'kada-credential-dispatch-'))), fixture = new URL('./fixtures/credential-request-worker.ts', import.meta.url);
  const received = Promise.withResolvers<void>(); let calls = 0;
  const service = createServer((req, _res) => { assert.equal(req.headers.authorization, 'Bearer synthetic-nonreplayed-credential'); calls++; received.resolve(); });
  await new Promise<void>(done => service.listen(0, '127.0.0.1', done));
  const port = String((service.address() as { port: number }).port);
  let worker = startRecoveryWorker(fixture, 'create', directory, port);
  try {
    await worker.ready(); await received.promise; assert.equal(await worker.stop(), 'SIGKILL');
    worker = startRecoveryWorker(fixture, 'recover', directory, port);
    const result = await worker.complete();
    assert.equal(result.status, 'blocked'); assert.equal(result.interrupted, true); assert.equal(result.valueAbsent, true);
    assert.equal(result.dispatch, 'sent\n'); assert.equal(calls, 1);
  } finally {
    await worker.stop(); service.closeAllConnections(); await new Promise<void>(done => service.close(() => done()));
    await rm(directory, { recursive: true, force: true, maxRetries: 5 });
  }
});
