import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recoveryTestTimeoutMs, startRecoveryWorker } from "./helpers.js";

for (const stage of ["review", "rework"]) test(`SIGKILL during ${stage} preserves reviewer/submission identity and retry counts`, { timeout: recoveryTestTimeoutMs }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), `pi-${stage}-crash-`)));
  const fixture = new URL("./fixtures/supervision-worker.ts", import.meta.url);
  let worker: ReturnType<typeof startRecoveryWorker> | undefined;
  try {
    worker = startRecoveryWorker(fixture, "create", directory, stage);
    const before = await worker.ready();
    assert.equal(await worker.stop(), "SIGKILL");
    await writeFile(join(directory, "release"), "resume");
    worker = startRecoveryWorker(fixture, "recover", directory, stage);
    const after = await worker.complete();
    assert.equal(after.type, "completed");
    assert.equal(after.rootRequest, before.rootRequest);
    assert.equal(after.reworks, before.reworks);
    assert.equal(after.reworkInputs, stage === "rework" ? 1 : 0);
    if (stage === "review") {
      assert.equal(after.reviewerId, before.reviewerId);
      assert.deepEqual(after.conversations, before.conversations);
    }
  } finally {
    await worker?.stop();
    await rm(directory, { recursive: true, force: true, maxRetries: 5 });
  }
});

test("SIGKILL after a submitted result spends the token budget preserves completion on restart", { timeout: recoveryTestTimeoutMs }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pi-settled-crash-")));
  const fixture = new URL("./fixtures/supervision-worker.ts", import.meta.url);
  let worker: ReturnType<typeof startRecoveryWorker> | undefined;
  try {
    worker = startRecoveryWorker(fixture, "create", directory, "settled");
    const before = await worker.ready();
    assert.ok(before.submissionId);
    assert.ok(before.candidateId);
    assert.ok(before.totalTokens >= 1);
    assert.equal(before.mechanical, null);
    assert.equal(before.completedEvents, 0);
    assert.equal(before.requests, 1);
    assert.equal(await worker.stop(), "SIGKILL");

    worker = startRecoveryWorker(fixture, "recover", directory, "settled");
    const after = await worker.complete();
    assert.equal(after.type, "completed");
    assert.equal(after.taskId, before.taskId);
    assert.equal(after.submissionId, before.submissionId);
    assert.equal(after.candidateId, before.candidateId);
    assert.equal(after.mechanical, true);
    assert.equal(after.completedEvents, 1);
    assert.equal(after.requests, 0);
    assert.equal(after.totalTokens, before.totalTokens);
  } finally {
    await worker?.stop();
    await rm(directory, { recursive: true, force: true, maxRetries: 5 });
  }
});
